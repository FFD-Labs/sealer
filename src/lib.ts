import { ChunkSplitter } from 'cafe-utility'
import { bytesToHex, createPublicClient, createWalletClient, encodeAbiParameters, http, isAddress, isAddressEqual, keccak256, parseAbi, parseAbiParameters, zeroHash, type Address, type Hex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { mainnet } from 'viem/chains'

export type Config = { rpc: string; gateway: string; site: string; contract: Address; custody?: Address; signer?: Address; postage?: string; rpcs?: Record<string, string>; contracts?: Address[] }

export const abi = parseAbi([
    'function anchor(bytes32 ref)',
    'function anchoredAt(bytes32 ref) view returns (uint64 at, uint64 block)',
    'function assign(uint128 from, uint128 to, bytes32 ref)',
    'function recordOf(uint256 id) view returns (bytes32)',
    'function mint(uint256[] ids, address[] to)',
    'function owner() view returns (address)',
    'function setBaseURI(string uri)',
    'function ownerOf(uint256 id) view returns (address)',
    'function transferBatch(uint256[] ids, address[] to)',
    'function transferBySig(uint256 id, address to, bytes signature)',
    'function assigned(uint128 from, uint128 to, bytes32 ref) view returns (bool)',
    'event Anchored(bytes32 indexed ref, uint64 at)'
])

export const transferDigest = (contract: Address, chainId: number, id: bigint, to: Address) =>
    keccak256(encodeAbiParameters(parseAbiParameters('uint256, address, uint256, address'), [BigInt(chainId), contract, id, to]))

export const signTransfer = (contract: Address, chainId: number, id: bigint, to: Address, key: Hex) =>
    privateKeyToAccount(key).signMessage({ message: { raw: transferDigest(contract, chainId, id, to) } })

const explorers: { [chainId: number]: string } = { 1: 'https://etherscan.io', 11155111: 'https://sepolia.etherscan.io' }

export const hex = (ref: string) => (ref.startsWith('0x') ? ref : `0x${ref}`) as Hex

export function wallet(rpc: string, key = process.env.PRIVATE_KEY as Hex) {
    const account = privateKeyToAccount(key)
    const transport = http(rpc)
    return { wallet: createWalletClient({ account, transport }), client: createPublicClient({ transport }) }
}

export async function send(config: Config, functionName: 'anchor' | 'assign' | 'mint' | 'transferBatch', args: readonly unknown[], key?: Hex) {
    const { wallet: w, client } = wallet(config.rpc, key)
    const hash = await w.writeContract({ address: config.contract, abi, functionName, args, chain: null } as never)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw Error(`${functionName} reverted`)
    return hash
}

export async function upload(config: Config, data: Uint8Array<ArrayBuffer>): Promise<Hex> {
    const stamp: Record<string, string> = config.postage ? { 'swarm-postage-batch-id': config.postage, 'swarm-pin': 'true' } : {}
    const response = await fetch(`${config.gateway}/bytes`, { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream', ...stamp } })
    if (!response.ok) throw Error(`upload failed: ${response.status}`)
    const { reference } = (await response.json()) as { reference: string }
    return `0x${reference}`
}

export async function download(gateway: string, ref: Hex) {
    const response = await fetch(`${gateway}/bytes/${ref.slice(2)}`)
    if (!response.ok) throw Error(`download failed: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

export const swarmHash = async (data: Uint8Array) => bytesToHex((await ChunkSplitter.root(data)).hash())

export const chainIdOf = (rpc: string) => createPublicClient({ transport: http(rpc) }).getChainId()

export const stickerUrl = (site: string, chainId: number, contract: Address, id: number, key: Hex) => `${site}#${chainId}:${contract}/${id}.${key.slice(2)}`

// <chainId>:<contract>/<id>.<key>, or the first format, <id>.<key>, which takes the contract from the page config
export function parseSticker(hash: string) {
    const match = /^#?(?:(\d+):(0x[0-9a-fA-F]{40})\/)?(\d+)\.([0-9a-fA-F]{64})$/.exec(hash)
    if (!match) return null
    const [, chainId, contract, id = '', key = ''] = match
    return { chainId: chainId ? Number(chainId) : null, contract: (contract ?? null) as Address | null, id: BigInt(id), key: `0x${key}` as Hex }
}

export class NotOfficial extends Error {}

const rpcOf = (config: Config, chainId: number | null) => (chainId === null ? config.rpc : (config.rpcs?.[chainId] ?? config.rpc))

async function isOfficial(config: Config, chainId: number, contract: Address) {
    if ([config.contract, ...(config.contracts ?? [])].some(listed => isAddressEqual(listed, contract))) return true
    if (chainId !== 1) return false
    const client = createPublicClient({ chain: mainnet, transport: http(rpcOf(config, 1)) })
    const listed = await client.getEnsText({ name: 'fairfooddata.eth', key: 'ffd.contract' }).catch(() => null)
    return !!listed && isAddress(listed) && isAddressEqual(listed, contract)
}

export async function scan(url: string, config: Config) {
    const parsed = parseSticker(new URL(url).hash)
    if (!parsed) throw Error('not a sticker link')
    const { id, key } = parsed
    const sticker = privateKeyToAddress(key)
    const client = createPublicClient({ transport: http(rpcOf(config, parsed.chainId)) })
    const chainId = await client.getChainId()
    if (parsed.chainId !== null && parsed.chainId !== chainId) throw Error(`no RPC for chain ${parsed.chainId}`)
    const address = parsed.contract ?? config.contract
    if (!(await isOfficial(config, chainId, address))) throw new NotOfficial(`contract ${address} is not listed by Fair Food Data`)
    const contract = { address, abi } as const
    const run = await client.readContract({ ...contract, functionName: 'recordOf', args: [id] })
    const owner = await client.readContract({ ...contract, functionName: 'ownerOf', args: [id] }).catch(() => null)
    const events = []
    const queue = run === zeroHash ? [] : [run]
    const seen = new Set<Hex>()
    while (queue.length) {
        const ref = queue.shift()!
        if (seen.has(ref)) continue
        seen.add(ref)
        const bytes = await download(config.gateway, ref)
        const data = JSON.parse(new TextDecoder().decode(bytes)) as { at: string; inputs?: Hex[] } & Record<string, unknown>
        const [anchored, block] = await client.readContract({ ...contract, functionName: 'anchoredAt', args: [ref] })
        const at = anchored ? new Date(Number(anchored) * 1000).toISOString() : null
        events.push({ ref, at, block, verified: at !== null && (await swarmHash(bytes)) === ref, data })
        queue.push(...(data.inputs ?? []).map(hex))
    }
    events.sort((a, b) => a.data.at.localeCompare(b.data.at))
    const explorer = explorers[chainId]
    const anchors = await Promise.all(
        events.map(async ({ block, ...e }) => {
            const logs = explorer && block ? await client.getContractEvents({ ...contract, eventName: 'Anchored', args: { ref: e.ref }, fromBlock: block, toBlock: block }).catch(() => []) : []
            const tx = logs[0]?.transactionHash
            return { ...e, tx: tx ? `${explorer}/tx/${tx}` : null, file: `${config.gateway}/bytes/${e.ref.slice(2)}` }
        })
    )
    const nft: 'not minted' | 'yours' | 'custody' | 'moved' =
        owner === null ? 'not minted' : isAddressEqual(owner, sticker) ? 'yours' : config.custody && isAddress(config.custody) && isAddressEqual(owner, config.custody) ? 'custody' : 'moved'
    return { id: Number(id), chainId, contract: address, sticker, run: run === zeroHash ? null : run, events: anchors, owner, nft }
}
