import { Numbers } from 'cafe-utility'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { serve } from './gateway.ts'
import { abi, chainIdOf, scan, send, stickerUrl, upload, wallet, type Config } from './lib.ts'
import { sealBatch, serveSealer, type Batch } from './sealer.ts'
import { publishSite, siteUrl } from './site.ts'

const configPath = process.env.CONFIG ?? 'web/public/config.json'
const stickersPath = process.env.STICKERS ?? 'data/stickers.json'
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 4) + '\n')

const [command, ...args] = process.argv.slice(2)

if (command === 'deploy') {
    const [rpc = 'http://127.0.0.1:8545', gateway = 'https://bzz.limo', site = 'https://fairfooddata.org/p.html'] = args
    const { wallet: w, client } = wallet(rpc)
    const { bytecode } = readJson<{ bytecode: { object: Hex } }>('out/FairFood.sol/FairFood.json')
    const hash = await w.deployContract({ abi, bytecode: bytecode.object, chain: null })
    const { contractAddress } = await client.waitForTransactionReceipt({ hash })
    writeJson(configPath, { rpc, gateway, site, contract: contractAddress })
    console.log(contractAddress)
} else if (command === 'stickers') {
    const config = readJson<Config>(configPath)
    const [from, to] = args.map(Number) as [number, number]
    const chainId = await chainIdOf(config.rpc)
    const list: Record<number, Address> = {}
    for (const id of Numbers.range(from, to)) {
        const key = generatePrivateKey()
        list[id] = privateKeyToAddress(key)
        console.log(stickerUrl(config.site, chainId, config.contract, id, key))
    }
    mkdirSync(dirname(stickersPath), { recursive: true })
    writeJson(stickersPath, list)
} else if (command === 'seal') {
    const config = readJson<Config>(configPath)
    const [file = '', ...inputs] = args
    const record = { ...readJson<Record<string, unknown>>(file), ...(inputs.length ? { inputs: inputs.map(ref => ref.replace(/^0x/, '')) } : {}) }
    const ref = await upload(config, new TextEncoder().encode(JSON.stringify(record)))
    const [anchored] = await wallet(config.rpc).client.readContract({ address: config.contract, abi, functionName: 'anchoredAt', args: [ref] })
    if (!anchored) await send(config, 'anchor', [ref])
    console.log(ref)
} else if (command === 'assign') {
    const [from = '', to = '', ref = ''] = args
    console.log(await send(readJson<Config>(configPath), 'assign', [BigInt(from), BigInt(to), ref]))
} else if (command === 'mint') {
    const list = readJson<Record<string, Address>>(stickersPath)
    const [from, to, custody] = args
    const ids = Numbers.range(Number(from), Number(to)).map(BigInt)
    const owners = ids.map(id => (custody as Address) ?? list[id.toString()])
    console.log(await send(readJson<Config>(configPath), 'mint', [ids, owners]))
} else if (command === 'handover') {
    const list = readJson<Record<string, Address>>(stickersPath)
    const [from, to] = args.map(Number) as [number, number]
    const ids = Numbers.range(from, to).map(BigInt)
    const key = (process.env.CUSTODY_KEY ?? process.env.PRIVATE_KEY) as Hex
    console.log(await send(readJson<Config>(configPath), 'transferBatch', [ids, ids.map(id => list[id.toString()])], key))
} else if (command === 'site') {
    const config = readJson<Config>(configPath)
    const site = `${await siteUrl(config.gateway, process.env.PRIVATE_KEY as Hex)}p.html`
    writeJson(configPath, { ...config, site })
    execSync('npx vite build')
    writeJson('dist/config.json', { ...config, site })
    await publishSite(config.gateway, 'dist', process.env.PRIVATE_KEY as Hex)
    console.log(site)
} else if (command === 'custody' || command === 'signer') {
    writeJson(configPath, { ...readJson<Config>(configPath), [command]: args[0] as Address })
    console.log(args[0])
} else if (command === 'batch') {
    console.log(JSON.stringify(await sealBatch(readJson<Config>(configPath), readJson<Batch>(args[0] ?? ''), process.env.PRIVATE_KEY as Hex), null, 4))
} else if (command === 'sealer') {
    const token = process.env.SEALER_TOKEN
    if (!token) throw Error('set SEALER_TOKEN')
    const port = Number(args[0] ?? 8090)
    serveSealer(readJson<Config>(configPath), process.env.PRIVATE_KEY as Hex, token, process.env.BATCHES ?? 'data/batches', port)
    console.log(`sealing service on ${port}`)
} else if (command === 'gateway') {
    const port = Number(args[0] ?? 8080)
    const key = (process.env.GATEWAY_KEY ?? process.env.PRIVATE_KEY) as Hex
    await serve(readJson<Config>(configPath), readJson<Record<string, Address>>(stickersPath), key, port)
    console.log(`transfer gateway on ${port}`)
} else if (command === 'scan') {
    console.log(JSON.stringify(await scan(args[0] ?? '', readJson<Config>(configPath)), null, 4))
} else {
    console.log('usage: deploy [rpc gateway site] | stickers <from> <to> | seal <file> [input refs] | assign <from> <to> <ref> | mint <from> <to> [custody] | handover <from> <to> | custody <address> | signer <address> | batch <file> | sealer [port] | site | gateway [port] | scan <url>')
}
