import type { Socket } from 'bun';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import Server, { type Miner, type Worker } from './server';
import { type Request, type Response, type Event, StratumError } from './server/protocol';
import type Templates from './templates/index.ts';
import { Address, type IRawHeader } from '../../wasm/kaspa';
import { Encoding, encodeJob } from './templates/jobs/encoding.ts';
import { SharesManager } from './sharesManager';
import { jobsNotFound, activeMinerGuage, varDiff } from '../prometheus';
import Monitoring from '../monitoring/index.ts';
import { DEBUG } from '../../index';
import { Mutex } from 'async-mutex';
import { metrics } from '../../index';
import Denque from 'denque';
import JsonBig from 'json-bigint';
import config from '../../config/config.json';
import logger from '../monitoring/datadog';
import { getSocketLogData } from './utils.ts';

const bitMainRegex = new RegExp('.*(GodMiner).*', 'i');

const MIN_DIFF = config.stratum[0].minDiff || 64;
const MAX_DIFF = config.stratum[0].maxDiff || 131072;
const DEFAULT_DIFF = config.stratum[0].difficulty || 2048;

export default class Stratum extends EventEmitter {
  server: Server;
  private templates: Templates;
  private difficulty: number;
  private subscriptors: Set<Socket<Miner>> = new Set();
  private monitoring: Monitoring;
  sharesManager: SharesManager;
  private minerDataLock = new Mutex();
  private extraNonceSize: number;
  private clampPow2: boolean;
  private varDiff: boolean;
  private extraNonce: number;
  public port: number;

  constructor(
    templates: Templates,
    initialDifficulty: number,
    port: number,
    sharesPerMin: number,
    clampPow2: boolean,
    varDiff: boolean,
    extraNonce: number,
    stratumMinDiff: number,
    stratumMaxDiff: number
  ) {
    super();
    this.monitoring = new Monitoring();
    this.port = port;
    this.sharesManager = new SharesManager(initialDifficulty, stratumMinDiff, stratumMaxDiff, port);
    this.server = new Server(
      port,
      initialDifficulty,
      this.onMessage.bind(this),
      this.sharesManager
    );
    this.difficulty = initialDifficulty;
    this.templates = templates;
    this.clampPow2 = clampPow2;
    this.varDiff = varDiff;
    this.extraNonce = extraNonce;
    this.templates.register((id, hash, timestamp, header) =>
      this.announceTemplate(id, hash, timestamp, header)
    );
    this.monitoring.log(`Stratum ${this.port}: Initialized with difficulty ${this.difficulty}`);

    // Start the VarDiff thread
    this.clampPow2 = clampPow2 || true; // Enable clamping difficulty to powers of 2
    this.varDiff = varDiff || false;
    if (this.varDiff) {
      this.sharesManager
        .startVardiffThread(sharesPerMin, this.clampPow2)
        .then(() => {
          this.monitoring.log(`Stratum ${this.port}: VarDiff thread started successfully.`);
        })
        .catch(error => {
          this.monitoring.error(`Stratum ${this.port}: Failed to start VarDiff thread: `, error);
        });
    }

    this.extraNonceSize = Math.min(Number(this.extraNonce), 3) || 0;
  }

  announceTemplate(id: string, hash: string, timestamp: bigint, header: IRawHeader) {
    this.monitoring.log(`Stratum ${this.port}: Announcing new template ${id}, hash: ${hash}`);
    const tasksData: { [key in Encoding]?: string } = {};
    Object.values(Encoding)
      .filter(value => typeof value !== 'number')
      .forEach(value => {
        const encoding = Encoding[value as keyof typeof Encoding];
        const encodedParams = encodeJob(hash, timestamp, encoding, header);
        const task: Event<'mining.notify'> = {
          method: 'mining.notify',
          params: [id, encodedParams],
        };
        if (encoding === Encoding.Bitmain) {
          task.params.push(timestamp);
        }
        tasksData[encoding] = JsonBig.stringify(task);
      });
    this.subscriptors.forEach(socket => {
      if (socket.readyState === 'closed') {
        // this.monitoring.debug(
        //   `Stratum ${this.port}: Deleting socket on closed stats for: ${socket.data.workers}`
        // );
        logger.warn('miner-socket-state-detected', getSocketLogData(socket));
        this.subscriptors.delete(socket);
        // try {
        //   socket.data.closeReason = 'Stratum: socket.readyState === "closed"';
        //   socket.end();
        // } catch (error) {
        //   this.monitoring.error(`Stratum ${this.port}: Error deleting socket: `, error);
        // }
      } else {
        socket.data.workers.forEach((worker, _) => {
          if (this.varDiff) {
            const workerStats =
              this.sharesManager.getMiners().get(worker.address)?.workerStats?.get(worker.name) ??
              null;
            let check = true;
            if (workerStats) {
              check = workerStats.varDiffEnabled;
            } else {
              this.monitoring.log(`Stratum ${this.port}: Worker stat not found for ${worker.name}`);
            }
            if (check) {
              let varDiff = this.sharesManager.getClientVardiff(worker);
              // Store current difficulty before any updates
              const currentDifficulty = socket.data.difficulty;
              if (varDiff != currentDifficulty && varDiff != 0) {
                const updated = this.sharesManager.updateSocketDifficulty(
                  worker.address,
                  worker.name,
                  varDiff
                );
                if (updated) {
                  this.monitoring.debug(
                    `Stratum ${this.port}: Updating difficulty for worker ${worker.name} from ${currentDifficulty} to ${varDiff}`
                  );
                  this.reflectDifficulty(socket, worker.name);
                  this.sharesManager.startClientVardiff(worker);
                }
              }
            }
          }
        });

        socket.write(tasksData[socket.data.encoding] + '\n');
      }
    });
  }

  reflectDifficulty(socket: Socket<Miner>, workerName: string) {
    const event: Event<'mining.set_difficulty'> = {
      method: 'mining.set_difficulty',
      params: [socket.data.difficulty],
    };
    socket.write(JSON.stringify(event) + '\n');
  }

  // Function to check if a number is power of 2
  isPowerOf2(num: number): boolean {
    return (num & (num - 1)) === 0 && num > 0;
  }

  // Function to round to the nearest power of 2
  roundToNearestPowerOf2(num: number): number {
    if (num < MIN_DIFF || num > MAX_DIFF) return DEFAULT_DIFF;

    let pow = 1;
    while (pow < num) {
      pow *= 2;
    }

    const lower = pow / 2;
    const upper = pow;

    // Choose the nearest power of 2
    return num - lower < upper - num ? lower : upper;
  }

  // Function to extract and validate difficulty
  parseDifficulty(input: string): number | null {
    const validPattern = /^(d=|diff=)?\d+$/i;

    if (!validPattern.test(input)) {
      return null;
    }

    const match = input.match(/(\d+)/);
    if (match) {
      const diff = Number(match[0]);
      if (!isNaN(diff)) {
        return diff;
      }
    }
    return null;
  }

  // Function to apply clamping logic
  getDifficulty(input: string): number {
    const diff = this.parseDifficulty(input);

    if (diff === null || diff < MIN_DIFF || diff > MAX_DIFF) {
      this.monitoring.debug(
        `Stratum: Invalid difficulty input: ${input}. Using default: ${DEFAULT_DIFF}`
      );
      return -1;
    }

    // Clamp to range
    const clampedDiff = Math.min(Math.max(diff, MIN_DIFF), MAX_DIFF);

    // Ensure power-of-2 clamping
    const finalDiff = this.isPowerOf2(clampedDiff)
      ? clampedDiff
      : this.roundToNearestPowerOf2(clampedDiff);

    this.monitoring.log(`Stratum: User requested: ${diff}, applied: ${finalDiff}`);
    return finalDiff;
  }

  private async onMessage(socket: Socket<Miner>, request: Request) {
    const release = await this.minerDataLock.acquire();
    try {
      let response: Response = {
        id: request.id,
        result: true,
        error: null,
      };

      switch (request.method) {
        case 'mining.subscribe': {
          if (this.subscriptors.has(socket)) {
            logger.warn('miner-already-subscribed', getSocketLogData(socket));
            throw Error('Already subscribed');
          }
          const minerType = request.params[0]?.toLowerCase() ?? '';
          response.result = [true, 'EthereumStratum/1.0.0'];

          // Format extranonce as a hexadecimal string with padding
          if (this.extraNonceSize > 0) {
            socket.data.extraNonce = randomBytes(2).toString('hex');
          }
          if (bitMainRegex.test(minerType)) {
            socket.data.encoding = Encoding.Bitmain;
            response.result = [
              null,
              socket.data.extraNonce,
              8 - Math.floor(socket.data.extraNonce.length / 2),
            ];
          }
          socket.data.asicType = request.params[0] || '';
          this.subscriptors.add(socket);
          this.emit('subscription', socket.remoteAddress, request.params[0]);
          this.monitoring.log(
            `Stratum ${this.port}: Miner subscribed from ${socket.remoteAddress}`
          );

          logger.info('miner-subscribed', getSocketLogData(socket));
          break;
        }
        case 'mining.authorize': {
          const [address, name] = request.params[0].split('.');
          let varDiffStatus = false;
          let userDiff = this.difficulty; // Defaults to the ports default difficulty
          const userDiffInput = request.params[1];
          if (this.port === 8888 && (userDiffInput != '' || /\d/.test(userDiffInput))) {
            // Only when they connect to this port, allow user defined diff
            userDiff = this.getDifficulty(userDiffInput);
            if (userDiff == -1) {
              // Incorrectly set difficulty.
              userDiff = DEFAULT_DIFF;
              varDiffStatus = true;
            }
            this.monitoring.debug(
              `Stratum: Mining authorize request with: ${request.params[0]} - ${userDiffInput}`
            );
            this.monitoring.log(`Stratum: Extracted user diff value: ${userDiff}`);
          }

          if (!Address.validate(address))
            throw Error(
              `Invalid address, parsed address: ${address}, request: ${request.params[0]}`
            );
          if (!name) throw Error(`Worker name is not set. Request: ${request.params[0]}`);

          const worker: Worker = { address, name: name };
          if (socket.data.workers.has(worker.name)) {
            logger.warn('miner-duplicate-worker', getSocketLogData(socket, { address, name }));
            throw Error(`Worker with duplicate name: ${name} for address: ${address}.`);
          }
          const sockets = this.sharesManager.getMiners().get(worker.address)?.sockets || new Set();
          socket.data.workers.set(worker.name, worker);
          sockets.add(socket);

          if (!this.sharesManager.getMiners().has(worker.address)) {
            this.sharesManager.getMiners().set(worker.address, {
              sockets,
              workerStats: new Map(),
            });
          }

          const minerData = this.sharesManager.getMiners().get(worker.address)!;
          // if (!minerData.workerStats.has(worker.name)) {
          minerData.workerStats.set(worker.name, {
            blocksFound: 0,
            sharesFound: 0,
            sharesDiff: 0,
            staleShares: 0,
            invalidShares: 0,
            workerName: worker.name,
            startTime: Date.now(),
            lastShare: Date.now(),
            varDiffStartTime: Date.now(),
            varDiffSharesFound: 0,
            varDiffWindow: 0,
            minDiff: userDiff,
            recentShares: new Denque<{
              timestamp: number;
              difficulty: number;
              nonce: bigint;
            }>(),
            hashrate: 0,
            asicType: socket.data.asicType,
            varDiffEnabled: varDiffStatus,
          });
          // }

          // Set extranonce
          let extraNonceParams: any[] = [socket.data.extraNonce];
          if (socket.data.encoding === Encoding.Bitmain && socket.data.extraNonce != '') {
            extraNonceParams = [
              socket.data.extraNonce,
              8 - Math.floor(socket.data.extraNonce.length / 2),
            ];
          }
          const event: Event<'mining.set_extranonce'> = {
            method: 'mining.set_extranonce',
            params: extraNonceParams,
          };
          socket.write(JSON.stringify(event) + '\n');

          // Set initial difficulty for this worker
          const workerStats = minerData.workerStats.get(worker.name)!;
          socket.data.difficulty = workerStats.minDiff;
          this.reflectDifficulty(socket, worker.name);
          metrics.updateGaugeValue(
            varDiff,
            [worker.name, this.port.toString()],
            workerStats.minDiff
          );

          if (DEBUG)
            this.monitoring.debug(
              `Stratum ${this.port}: Authorizing worker - Address: ${address}, Worker Name: ${name}`
            );

          logger.info('miner-authorize', getSocketLogData(socket, { address, name }));

          metrics.updateGaugeValue(
            activeMinerGuage,
            [name, address, socket.data.asicType, socket.data.port.toString()],
            Math.floor(Date.now() / 1000)
          );
          break;
        }
        case 'mining.submit': {
          const [address, name] = request.params[0].split('.');
          // development retantion tag will override production retantion tag
          logger.info('miner-submit', {
            ddtags: 'retention:development',
            ...getSocketLogData(socket, { address, name }),
          });
          if (DEBUG)
            this.monitoring.debug(`Stratum ${this.port}: Submitting job for Worker Name: ${name}`);
          const worker = socket.data.workers.get(name);
          if (DEBUG)
            this.monitoring.debug(
              `Stratum ${this.port}: Checking worker data on socket for : ${name}`
            );
          if (!worker || worker.address !== address) {
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Mismatching worker details - worker.Addr: ${worker?.address}, Address: ${address}, Worker Name: ${name}`
              );

            // Log unauthorized share submission attempt
            logger.warn(
              'miner-unauthorized-share-submission',
              getSocketLogData(socket, { address, name })
            );

            throw Error(
              `Mismatching worker details - worker.Addr: ${worker?.address}, Address: ${address}, Worker Name: ${name}`
            );
          }
          const hash = this.templates.getHash(request.params[1]);
          if (!hash) {
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Job not found - Address: ${address}, Worker Name: ${name}`
              );
            metrics.updateGaugeInc(jobsNotFound, [name, address]);
            response.result = false;
            response.error = new StratumError('job-not-found').toDump();
            return response;
          } else {
            const minerId = name;
            const minerData = this.sharesManager.getMiners().get(worker.address);
            const workerStats = minerData?.workerStats.get(worker.name);
            const workerDiff = workerStats?.minDiff;
            const socketDiff = socket.data.difficulty;
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Current difficulties , Worker Name: ${minerId} - Worker: ${workerDiff}, Socket: ${socketDiff}`
              );
            const currentDifficulty = workerDiff || socketDiff;
            if (DEBUG)
              this.monitoring.debug(
                `Stratum ${this.port}: Adding Share - Address: ${address}, Worker Name: ${name}, Hash: ${hash}, Difficulty: ${currentDifficulty}`
              );

            if (socket.data.extraNonce !== '') {
              const extranonce2Len = 16 - socket.data.extraNonce.length;
              if (request.params[2].length <= extranonce2Len) {
                request.params[2] =
                  socket.data.extraNonce + request.params[2].padStart(extranonce2Len, '0');
              }
            }

            try {
              let nonce: bigint;
              if (socket.data.encoding === Encoding.Bitmain) {
                nonce = BigInt(request.params[2]);
              } else {
                nonce = BigInt('0x' + request.params[2]);
              }
              this.sharesManager.addShare(
                minerId,
                worker.address,
                hash,
                currentDifficulty,
                nonce,
                this.templates,
                request.params[1]
              );
            } catch (error: any) {
              logger.error(
                'miner-error-share-processing',
                getSocketLogData(socket, { address, name })
              );

              if (!(error instanceof Error)) throw error;
              switch (error.message) {
                case 'Duplicate share':
                  this.monitoring.debug(`Stratum ${this.port}: DUPLICATE_SHARE`);
                  response.error = new StratumError('duplicate-share').toDump();
                  break;
                case 'Stale header':
                  this.monitoring.debug(`Stratum ${this.port}: Stale Header - JOB_NOT_FOUND`);
                  response.error = new StratumError('job-not-found').toDump();
                  break;
                case 'Invalid share':
                  this.monitoring.debug(`Stratum ${this.port}: LOW_DIFFICULTY_SHARE`);
                  response.error = new StratumError('low-difficulty-share').toDump();
                  break;
                default:
                  throw error;
              }
              response.result = false;
            }
          }
          break;
        }
        default: {
          throw new StratumError('unknown');
        }
      }
      return response;
    } finally {
      release();
    }
  }
}
