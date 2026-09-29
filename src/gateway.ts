import { createServer } from 'node:http'
import { createPublicClient, createWalletClient, formatEther, http, recoverMessageAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { abi, transferDigest, type Config } from './lib.ts'

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
}

export async function serve(config: Config, stickers: Record<string, Address>, key: Hex, port: number) {
    const transport = http(config.rpc)
    const client = createPublicClient({ transport })
    const account = privateKeyToAccount(key)
    const wallet = createWalletClient({ account, transport })
    const contract = { address: config.contract, abi } as const

    const owner = await client.readContract({ ...contract, functionName: 'owner' })
    if (owner === account.address) throw Error('the gateway needs its own key, not the contract owner')
    console.log(`gateway ${account.address} holds ${formatEther(await client.getBalance(account))} ETH`)

    return createServer(async (request, response) => {
        const json = (status: number, body: unknown) => response.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body))
        if (request.method === 'OPTIONS') return response.writeHead(204, cors).end()
        try {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(chunk as Buffer)
            const { id, to, signature } = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; to: Address; signature: Hex }
            const holder = await client.readContract({ ...contract, functionName: 'ownerOf', args: [BigInt(id)] })
            if (holder !== stickers[id]) throw Error('this bag has already moved, pay your own gas')
            const chainId = await client.getChainId()
            const signer = await recoverMessageAddress({ message: { raw: transferDigest(config.contract, chainId, BigInt(id), to) }, signature })
            if (signer !== holder) throw Error('signature is not the sticker key')
            const hash = await wallet.writeContract({ ...contract, functionName: 'transferBySig', args: [BigInt(id), to, signature], chain: null })
            const receipt = await client.waitForTransactionReceipt({ hash })
            if (receipt.status !== 'success') throw Error('transfer reverted')
            json(200, { hash })
        } catch (error) {
            json(400, { error: String(error) })
        }
    }).listen(port)
}
