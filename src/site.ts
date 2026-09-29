import { Binary } from 'cafe-utility'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { keccak256, stringToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const topic = keccak256(stringToHex('fairfooddata-site')).slice(2)

function tar(dir: string) {
    const parts: Uint8Array[] = []
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
        const path = join(entry.parentPath, entry.name)
        const name = relative(dir, path)
        const data = readFileSync(path)
        const header = new Uint8Array(512)
        const field = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset)
        field(0, name)
        field(100, '0000644')
        field(124, data.length.toString(8).padStart(11, '0'))
        field(148, '        ')
        field(156, '0')
        field(257, 'ustar\u000000')
        field(148, header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\u0000 ')
        parts.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512))
    }
    return Binary.concatBytes(...parts, new Uint8Array(1024))
}

async function call(url: string, init: RequestInit = {}) {
    const response = await fetch(url, init)
    if (!response.ok) throw Error(`${init.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`)
    return response
}

const ownerOf = (privateKey: Hex) => privateKeyToAccount(privateKey).address.slice(2).toLowerCase()

export async function siteUrl(gateway: string, privateKey: Hex) {
    const { reference } = (await (await call(`${gateway}/feeds/${ownerOf(privateKey)}/${topic}`, { method: 'POST' })).json()) as { reference: string }
    return `${gateway}/bzz/${reference}/`
}

export async function publishSite(gateway: string, dir: string, privateKey: Hex) {
    const account = privateKeyToAccount(privateKey)
    const owner = ownerOf(privateKey)
    const headers = { 'Content-Type': 'application/x-tar', 'Swarm-Collection': 'true', 'Swarm-Index-Document': 'p.html' }
    const { reference } = (await (await call(`${gateway}/bzz`, { method: 'POST', body: new Uint8Array(tar(dir)), headers })).json()) as { reference: string }
    const latest = await fetch(`${gateway}/feeds/${owner}/${topic}`)
    const index = latest.ok ? BigInt(`0x${latest.headers.get('swarm-feed-index-next')}`) : 0n
    const identifier = keccak256(Binary.concatBytes(Binary.hexToUint8Array(topic), Binary.numberToUint64(index, 'BE')))
    const chunk = new Uint8Array(await (await call(`${gateway}/chunks/${reference}`)).arrayBuffer())
    const signature = await account.signMessage({ message: { raw: keccak256(Binary.concatBytes(Binary.hexToUint8Array(identifier), Binary.hexToUint8Array(reference))) } })
    await call(`${gateway}/soc/${owner}/${identifier.slice(2)}?sig=${signature.slice(2)}`, { method: 'POST', body: chunk, headers: { 'Content-Type': 'application/octet-stream' } })
}
