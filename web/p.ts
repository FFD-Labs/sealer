import { NotOfficial, parseSticker, scan, type Config } from '../src/lib.ts'

type Record = {
    phase: 'intake' | 'cycle' | 'packing' | 'transport'
    kind?: 'measured' | 'declared'
    illustrative?: boolean
    version?: number
    at: string
    plant_id?: string | null
    fruit?: string
    kg?: number
    supplier?: string
    origin?: string
    delivery_note?: string | null
    machine?: string
    start?: string
    end?: string
    min_temperature_c?: number
    min_pressure_pa?: number
    kwh?: number
    declared?: { loads?: { trays: number; kg: number }[]; kg_out?: number; moisture_pct?: number | null }
    bags?: number
    bag_g?: number
    stickers?: { from: number; to: number }
    lot?: string
    destination?: string
    departure?: string
    arrival?: string
    carrier?: string | null
    tracking?: string | null
}

const app = document.getElementById('app')!
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const date = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const place = (value = '') => (value.startsWith('urn:bdf:site:') ? `Plant ${value.split(':').pop()}` : value)
const hours = (from = '', to = '') => `${Math.round((Date.parse(to) - Date.parse(from)) / 36e5)} h`
const sum = (list: { trays: number; kg: number }[] = [], key: 'trays' | 'kg') => list.reduce((total, load) => total + load[key], 0)
const origins: { [key: string]: string } = { first_hand: 'Bought as usual', second_grade: 'Second grade', rescued: 'Rescued surplus', undeclared: 'Not stated' }

const steps = {
    intake: (r: Record) => ({
        title: `${(r.fruit ?? 'fruit').replace(/^./, c => c.toUpperCase())} received`,
        rows: [['Weight', `${r.kg} kg`], ['Supplier', r.supplier], ['Origin', origins[r.origin ?? '']], ['Delivery note', r.delivery_note], ['Plant lot', r.plant_id]]
    }),
    cycle: (r: Record) => ({
        title: 'Freeze-dried',
        rows: [
            ['Machine', r.machine],
            ['Duration', hours(r.start, r.end)],
            ['Loaded', `${sum(r.declared?.loads, 'kg')} kg on ${sum(r.declared?.loads, 'trays')} trays`],
            ['Dried out', r.declared?.kg_out != null ? `${r.declared.kg_out} kg` : null],
            ['Coldest', r.min_temperature_c != null ? `${r.min_temperature_c} °C` : null],
            ['Lowest pressure', r.min_pressure_pa != null ? `${r.min_pressure_pa} Pa` : null],
            ['Moisture left', r.declared?.moisture_pct != null ? `${r.declared.moisture_pct} %` : null],
            ['Energy', r.kwh != null ? `${r.kwh} kWh` : null],
            ['Cycle', r.plant_id]
        ]
    }),
    packing: (r: Record) => ({
        title: 'Packed',
        rows: [['Bags', `${r.bags} × ${r.bag_g} g`], ['Stickers', r.stickers && `#${r.stickers.from} to #${r.stickers.to}`], ['Lot', r.lot], ['Order', r.plant_id]]
    }),
    transport: (r: Record) => ({
        title: 'Delivered',
        rows: [
            ['From', place(r.origin)],
            ['To', r.destination],
            ['Departed', r.departure && date(r.departure)],
            ['Arrived', r.arrival && date(r.arrival)],
            ['Carrier', r.carrier],
            ['Tracking', r.tracking]
        ]
    })
}

const nft = (state: string, owner: string | null): string[] =>
    ({
        'not minted': ['Not minted yet', 'The NFT for this bag has not been created yet.'],
        custody: ['Held by Fair Food Data', 'It moves to this sticker at the hand-over.'],
        yours: ["In this sticker's key", 'Whoever holds this sticker can move it to their own wallet.'],
        moved: ['Moved', `It now belongs to <code>${esc(owner)}</code>.`]
    })[state] ?? []

try {
    const config = (await (await fetch('./config.json')).json()) as Config
    const bag = await scan(location.href, config)
    const records = bag.events.map(event => ({ ...event, record: event.data as unknown as Record }))
    const [nftTitle, nftText] = nft(bag.nft, bag.owner)
    app.innerHTML = [
        `<p class="kicker"><span class="dot"></span>Bag #${bag.id} · Devcon 8</p>`,
        `<h1>From the plant <span>to your hands</span></h1>`,
        `<p class="lede">Every step below is stored on Swarm and anchored on Ethereum. Your phone just checked each one against its anchor.</p>`,
        records.some(({ record }) => record.illustrative)
            ? '<p class="notice">Demo data. These records are illustrative and do not describe a real production run.</p>'
            : '',
        bag.run ? '' : '<p class="notice">No packing run is recorded for this bag yet.</p>',
        '<ol>',
        ...records.map(({ record, ref, at, verified, tx, file }, i) => {
            const { title, rows } = steps[record.phase](record)
            return `<li class="step"><span class="num"></span><div class="card">
                <p class="stage">${String(i + 1).padStart(2, '0')} · ${esc(record.phase)} · ${day(record.at)}</p>
                <h2>${esc(title)}</h2>
                <div class="tags">
                    <span class="tag">${record.kind === 'measured' ? 'Measured by machine' : 'Typed by staff'}</span>
                    ${record.illustrative ? '<span class="tag wait">Illustrative</span>' : ''}
                    ${(record.version ?? 1) > 1 ? `<span class="tag wait">Correction v${record.version}</span>` : ''}
                </div>
                ${rows
                    .filter(([, value]) => value != null && value !== '')
                    .map(([key, value]) => `<div class="row"><span class="k">${esc(key)}</span><span class="v">${esc(value)}</span></div>`)
                    .join('')}
                <p class="check ${verified ? 'ok' : 'bad'}">${verified ? `✓ Matches its Ethereum anchor of ${date(at!)}` : '✗ Does not match any Ethereum anchor'}</p>
                <div class="links">
                    ${tx ? `<a class="btn" href="${tx}" target="_blank" rel="noopener">Ethereum tx ↗</a>` : ''}
                    <a class="btn" href="${file}" target="_blank" rel="noopener">Swarm file ↗</a>
                </div>
                <details><summary>Raw record</summary><pre>${esc(JSON.stringify(record, null, 2))}</pre><p>Swarm <code>${ref}</code></p></details>
            </div></li>`
        }),
        '</ol>',
        `<div class="card nft"><p class="stage">NFT #${bag.id}</p><h2><span>${nftTitle}</span></h2><p class="lede">${nftText}</p></div>`,
        '<footer>Anyone who has seen this QR can move this NFT. Never keep funds at its address.</footer>'
    ].join('')
} catch (error) {
    const notice = (title: string, text: string) => `<p class="notice"><strong>${title}</strong><br>${text}</p>`
    const details = `<details><summary>Technical details</summary><pre>${esc(error)}</pre></details>`
    if (!location.hash.slice(1)) {
        app.innerHTML = notice('No bag to show yet. Go get one. They are yummy.', 'Scan the QR code on a bag to follow its fruit from the plant to your hands.')
    } else if (!parseSticker(location.hash)) {
        app.innerHTML = notice('This link is incomplete', 'Scan the QR code on the bag again. The link may have been cut short when it was copied.')
    } else if (error instanceof NotOfficial) {
        app.innerHTML = notice('This is not a Fair Food Data bag', 'The QR code points to a contract that Fair Food Data has not published, so this page does not show it.') + details
    } else {
        console.error(error)
        app.innerHTML = notice("We couldn't check this bag right now", 'Check your connection and try again in a moment.') + details
    }
}
