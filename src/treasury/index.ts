import { EventEmitter } from 'events'
import Monitoring from '../monitoring';
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient } from "../../wasm/kaspa"

const startTime = BigInt(Date.now())

UtxoProcessor.setCoinbaseTransactionMaturityDAA('mainnet', 200n)
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-10', 200n)
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-11', 2000n)

export default class Treasury extends EventEmitter {
  privateKey: PrivateKey
  address: string
  processor: UtxoProcessor
  context: UtxoContext
  fee: number
  rpc: RpcClient
  private monitoring: Monitoring;

  constructor(rpc: RpcClient, networkId: string, privateKey: string, fee: number) {
    super()

    this.rpc = rpc  
    this.privateKey = new PrivateKey(privateKey)
    this.address = (this.privateKey.toAddress(networkId)).toString()
    this.processor = new UtxoProcessor({ rpc, networkId })
    this.context = new UtxoContext({ processor: this.processor })
    this.fee = fee
    this.monitoring = new Monitoring();
    this.monitoring.log(`Treasury: Pool Wallet Address: " ${this.address}`)

    this.registerProcessor()
  }


  private registerProcessor() {
    this.processor.addEventListener("utxo-proc-start", async () => {
      await this.context.clear()
      await this.context.trackAddresses([this.address])
    })

    this.processor.addEventListener('maturity', async (e) => {
      // @ts-ignore
      if (!e?.data?.data?.utxoEntries?.some(element => element?.isCoinbase)) return

      const { timestamps } = await this.rpc.getDaaScoreTimestampEstimate({
        daaScores: [ e.data.blockDaaScore ]
      })
      if (timestamps[0] < startTime) {
        return
      }

      // @ts-ignore
      const reward = e.data.value
      this.monitoring.log(`Treasury: Maturity event received. Reward: ${reward}, Event timestamp: ${Date.now()}`);
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n
      this.monitoring.log(`Treasury: Pool fees to retain on the coinbase cycle: ${poolFee}.`);
      this.emit('coinbase', reward - poolFee, poolFee)
    })

    this.processor.start()
  }
}