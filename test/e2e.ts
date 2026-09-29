import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { signTransfer, type Config } from '../src/lib.ts'
import type { Batch } from '../src/sealer.ts'

const dir = mkdtempSync(join(tmpdir(), 'ffd-'))
const anvil = spawn('anvil', ['--port', '8546'], { stdio: 'ignore' })
after(() => anvil.kill())

const env = {
    ...process.env,
    CONFIG: join(dir, 'config.json'),
    STICKERS: join(dir, 'stickers.json'),
    PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    CUSTODY_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    GATEWAY_KEY: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
}
const custody = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const cli = (...args: string[]) => execFileSync('npx', ['tsx', 'src/cli.ts', ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim()
const seal = (file: string, ...inputs: string[]) => cli('seal', `plant-fixtures/${file}.json`, ...inputs)
const config = () => JSON.parse(readFileSync(env.CONFIG, 'utf8')) as Config
const key = (url: string) => `0x${url.split('.').pop()}` as const
const scan = (url: string) => JSON.parse(cli('scan', url)) as { run: string | null; nft: string; events: { verified: boolean; data: { phase: string; version: number } }[] }
const phases = (url: string) => scan(url).events.map(e => e.data.phase)
const versions = (url: string) => scan(url).events.map(e => e.data.version)

function correct(file: string, patch: Record<string, unknown>, ...inputs: string[]) {
    const path = join(dir, `${file}-v2.json`)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(`plant-fixtures/${file}.json`, 'utf8')), version: 2, ...patch }))
    return cli('seal', path, ...inputs)
}
function reverts(run: () => void, reason: RegExp) {
    try {
        run()
    } catch (error) {
        return assert.match(String((error as { stderr?: string }).stderr), reason)
    }
    assert.fail('did not revert')
}

test('two lots from sticker to scan', async () => {
    await setTimeout(1000)
    cli('deploy', 'http://127.0.0.1:8546')
    assert.match(await (await fetch(cli('site'))).text(), /Fair Food Data/)
    const stickers = cli('stickers', '1', '21').split('\n')
    const [bag1 = '', bag2 = ''] = stickers
    const bag15 = stickers[14] ?? ''
    const bag21 = stickers[20] ?? ''

    assert.equal(scan(bag1).run, null)
    cli('seal', env.STICKERS)

    const intakeA = seal('intake-a')
    const cycleA = seal('cycle-a', intakeA)
    const runA = seal('run-a', cycleA)
    cli('assign', '1', '10', runA)

    const intakeB = seal('intake-b')
    const cycleB1 = seal('cycle-b1', intakeB)
    const cycleB2 = seal('cycle-b2', intakeB)
    const runB = seal('run-b', cycleB1, cycleB2)
    cli('assign', '11', '20', runB)

    assert.deepEqual(phases(bag1), ['intake', 'cycle', 'packing'])
    assert.deepEqual(phases(bag15), ['intake', 'cycle', 'cycle', 'packing'])
    assert.equal(scan(bag1).nft, 'not minted')
    assert.equal(scan(bag21).run, null)
    assert.equal(seal('intake-a'), intakeA)

    cli('custody', custody)
    cli('mint', '1', '10')
    cli('mint', '11', '20', custody)
    assert.equal(scan(bag1).nft, 'yours')
    assert.equal(scan(bag15).nft, 'custody')
    cli('handover', '11', '20')
    assert.equal(scan(bag15).nft, 'yours')
    assert.equal(scan(bag2.replace(/[0-9a-f]{64}$/, 'ab'.repeat(32))).nft, 'moved')
    reverts(() => cli('mint', '21', '21'), /not packed/)

    const transportA = seal('transport-a', runA)
    cli('assign', '1', '10', transportA)
    cli('assign', '11', '20', seal('transport-b', runB))

    const delivered = scan(bag1)
    assert.deepEqual(
        delivered.events.map(e => e.data.phase),
        ['intake', 'cycle', 'packing', 'transport']
    )
    assert.ok(delivered.events.every(e => e.verified))
    assert.equal(delivered.nft, 'yours')
    assert.deepEqual(phases(bag15), ['intake', 'cycle', 'cycle', 'packing', 'transport'])

    const transportA2 = correct('transport-a', { supersedes: transportA }, correct('run-a', { supersedes: runA }, correct('cycle-a', { supersedes: cycleA }, intakeA)))
    cli('assign', '1', '10', transportA2)
    assert.deepEqual(phases(bag1), ['intake', 'cycle', 'packing', 'transport'])
    assert.deepEqual(versions(bag1), [1, 2, 2, 2])

    const gateway = spawn('npx', ['tsx', 'src/cli.ts', 'gateway', '8547'], { env, stdio: 'ignore' })
    after(() => gateway.kill())
    await setTimeout(3000)

    const to = '0x00000000000000000000000000000000000000ff'
    const transfer = async (url: string, id: number) =>
        (
            await fetch('http://127.0.0.1:8547', {
                method: 'POST',
                body: JSON.stringify({ id, to, signature: await signTransfer(config().contract, 31337, BigInt(id), to, key(url)) })
            })
        ).status

    assert.equal(await transfer(bag1, 1), 200)
    assert.equal(scan(bag1).nft, 'moved')
    assert.equal(await transfer(bag1, 1), 400)
    assert.equal(await transfer(bag2, 1), 400)
})

test('notary batches through the sealing service', async () => {
    cli('deploy', 'http://127.0.0.1:8546')
    const signer = generatePrivateKey()
    cli('signer', privateKeyToAddress(signer))
    const example = JSON.parse(readFileSync('notary-v1.3/example/batch-fixtures.json', 'utf8')) as Batch
    const sign = (key: `0x${string}`, ref: string) => privateKeyToAccount(key).signMessage({ message: { raw: `0x${ref}` } })
    const items = await Promise.all(example.items.map(async item => ({ ...item, signature: await sign(signer, item.ref) })))
    const batch = { ...example, signer: privateKeyToAddress(signer), items }
    const forged = { ...batch, batch_id: 'india-1/2026-09-25/0', items: [...items] }
    forged.items[3] = { ...items[3]!, signature: await sign(generatePrivateKey(), items[3]!.ref) }
    writeFileSync(join(dir, 'forged.json'), JSON.stringify(forged))

    const statuses = (results: { status: string; code?: string }[]) => results.map(r => r.code ?? r.status)
    assert.deepEqual(statuses(JSON.parse(cli('batch', join(dir, 'forged.json')))), [
        'sealed', 'sealed', 'sealed', 'signature_invalid', 'parent_rejected', 'parent_rejected', 'parent_rejected', 'sealed', 'parent_rejected'
    ])
    const bag = (id: number) => `https://fairfooddata.org/p.html#${id}.${'ab'.repeat(32)}`
    assert.deepEqual(phases(bag(1)), ['intake', 'cycle', 'packing', 'transport'])
    assert.equal(scan(bag(15)).run, null)

    const sealer = spawn('npx', ['tsx', 'src/cli.ts', 'sealer', '8548'], { env: { ...env, SEALER_TOKEN: 'secret', BATCHES: join(dir, 'batches') }, stdio: 'ignore' })
    after(() => sealer.kill())
    await setTimeout(3000)
    const api = (path: string, init: RequestInit = {}, token = 'secret') =>
        fetch(`http://127.0.0.1:8548/v1/batches${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } })
    const body = JSON.stringify(batch)

    assert.equal((await api('', { method: 'POST', body }, 'wrong')).status, 401)
    assert.equal((await api('', { method: 'POST', body: '{}' })).status, 422)
    assert.equal((await api('', { method: 'POST', body })).status, 202)
    assert.equal((await api('', { method: 'POST', body: JSON.stringify({ ...batch, created_at: 'later' }) })).status, 409)
    let report = { status: 'processing', items: [] as { status: string; assign_tx?: string }[] }
    while (report.status === 'processing') {
        await setTimeout(1000)
        report = await (await api(`/${batch.batch_id}`)).json()
    }
    assert.deepEqual(statuses(report.items), ['duplicate', 'duplicate', 'duplicate', 'sealed', 'sealed', 'sealed', 'sealed', 'duplicate', 'sealed'])
    assert.ok([0, 1, 2, 7].every(i => !report.items[i]!.assign_tx))
    assert.deepEqual(phases(bag(1)), ['intake', 'cycle', 'packing', 'transport'])
    assert.deepEqual(phases(bag(15)), ['intake', 'cycle', 'cycle', 'packing', 'transport'])
    assert.ok(scan(bag(15)).events.every(e => e.verified))
})
