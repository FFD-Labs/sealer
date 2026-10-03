import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createPublicClient, http, isAddressEqual, recoverMessageAddress, type Address, type Hex } from 'viem'
import { mainnet } from 'viem/chains'
import { abi, hex, send, swarmHash, upload, type Config } from './lib.ts'

type Payload = { inputs?: string[]; supersedes?: string | null; telemetry?: string | null; documents?: { ref: string }[] }
type Item = { kind: 'record' | 'blob'; ref: string; signature: Hex; payload?: Payload; payload_base64?: string; assign?: { from: number; to: number } | null }
export type Batch = { schema: string; batch_id: string; env: 'tst' | 'pro'; signer: Address; items: Item[] }
type Result = { ref: string; status: 'sealed' | 'duplicate' | 'rejected'; code?: string; upload?: string; anchor_tx?: Hex; assign_tx?: Hex }

const parents = (p: Payload) => [...(p.inputs ?? []), p.supersedes, p.telemetry, ...(p.documents ?? []).map(d => d.ref)].filter(r => r != null).map(hex)

export async function sealBatch(config: Config, batch: Batch, key: Hex) {
    const client = createPublicClient({ transport: http(config.rpc) })
    const env = (await client.getChainId()) === 1 ? 'pro' : 'tst'
    if (batch.env !== env) throw Error(`this service seals ${env} batches`)
    const signer =
        config.signer ?? (await createPublicClient({ chain: mainnet, transport: http(config.rpc) }).getEnsText({ name: 'fairfooddata.eth', key: 'ffd.signer' }))
    if (!signer || !isAddressEqual(batch.signer, signer as Address)) throw Error(`the batch signer is not ${signer}`)
    const contract = { address: config.contract, abi } as const
    const rejected = new Set<Hex>()
    const results: Result[] = []
    for (const item of batch.items) {
        const ref = hex(item.ref)
        const result: Result = { ref: item.ref, status: 'sealed' }
        results.push(result)
        try {
            if (item.payload && parents(item.payload).some(p => rejected.has(p))) throw Error('parent_rejected')
            const by = await recoverMessageAddress({ message: { raw: ref }, signature: item.signature }).catch(() => null)
            if (!by || !isAddressEqual(by, batch.signer)) throw Error('signature_invalid')
            const bytes = item.kind === 'record' ? new TextEncoder().encode(JSON.stringify(item.payload)) : new Uint8Array(Buffer.from(item.payload_base64 ?? '', 'base64'))
            if ((await swarmHash(bytes)) !== ref) throw Error('ref_mismatch')
            if (item.kind === 'record' && (await client.readContract({ ...contract, functionName: 'anchoredAt', args: [ref] }))[0]) result.status = 'duplicate'
            else {
                if ((await upload(config, bytes)) !== ref) throw Error('upload_mismatch')
                result.upload = item.ref
                if (item.kind === 'record') result.anchor_tx = await send(config, 'anchor', [ref], key)
            }
            const range = item.assign && ([BigInt(item.assign.from), BigInt(item.assign.to), ref] as const)
            if (range && !(await client.readContract({ ...contract, functionName: 'assigned', args: range })))
                result.assign_tx = await send(config, 'assign', range, key)
        } catch (error) {
            rejected.add(ref)
            Object.assign(result, { status: 'rejected', code: String((error as Error).message ?? error).split('\n')[0] })
        }
    }
    return results
}

export function serveSealer(config: Config, key: Hex, token: string, dir: string, port: number) {
    mkdirSync(dir, { recursive: true })
    const file = (id: string) => join(dir, `${encodeURIComponent(id)}.json`)
    const save = (id: string, value: unknown) => writeFileSync(file(id), JSON.stringify(value))
    const load = (id: string) => JSON.parse(readFileSync(file(id), 'utf8')) as { body: string; status: string }
    let queue = Promise.resolve()

    return createServer(async (request, response) => {
        const json = (status: number, body: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
        if (request.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' })
        const status = request.url?.match(/^\/v1\/batches\/(.+)$/)
        if (request.method === 'GET' && status) {
            const id = decodeURIComponent(status[1] ?? '')
            if (!existsSync(file(id))) return json(404, { error: 'no such batch' })
            const { body, ...rest } = load(id)
            return json(200, rest)
        }
        if (request.method !== 'POST' || request.url !== '/v1/batches') return json(404, { error: 'not found' })
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
            size += (chunk as Buffer).length
            if (size > 25_000_000) return json(413, { error: 'over 25 MB' })
            chunks.push(chunk as Buffer)
        }
        const body = Buffer.concat(chunks).toString()
        let batch: Batch
        try {
            batch = JSON.parse(body)
            if (batch.schema !== 'ffd/batch/1.0' || !/^[a-z0-9-]+\/\d{4}-\d{2}-\d{2}\/\d+$/.test(batch.batch_id) || !Array.isArray(batch.items)) throw Error()
        } catch {
            return json(422, { error: 'not an ffd/batch/1.0' })
        }
        const id = batch.batch_id
        if (existsSync(file(id)) && load(id).body !== body) return json(409, { error: 'batch_id exists with other content' })
        save(id, { body, status: 'processing', items: [] })
        queue = queue.then(() =>
            sealBatch(config, batch, key).then(
                items => save(id, { body, status: 'done', items }),
                error => save(id, { body, status: 'done', error: String((error as Error).message ?? error), items: [] })
            )
        )
        json(202, { batch_id: id })
    }).listen(port)
}
