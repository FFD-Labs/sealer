# Fair Food Data at Devcon 8: the brief

Written 22 Sep 2026, updated 24 Sep with FFD's answers on lot mixing, the plant records and custody, and 25 Sep with the Notary v1.3 split and the sealing service.

## The idea

A bag of freeze-dried fruit from India. A QR on the bag. Scan it and the phone shows where the fruit
came from (intake, freeze-drying, packing, transport) and proves that record wasn't changed later.
The bag also comes with an NFT that belongs to whoever holds the sticker.

That's all of it. The 100 pages of spec describe this idea plus a lot of machinery.

## How it works

| Piece | What it is |
|---|---|
| Sticker | `https://fairfooddata.org/p.html#<id>.<key>`. `id` is the bag's serial and NFT id. `key` is a fresh private key. Browsers never send what comes after `#` to a server. |
| Records | Each plant event (intake, cycle, packing run, transport) is a small JSON file uploaded to Swarm. A cycle names the intakes it dried; a packing run names the cycles it packed. Transport is declared when the bags reach the venue (doc 04, step 12): it names the run, and the sticker range is pointed at it instead. |
| Notary | FFD's. Collects the plant's messages and FFD's declarations, composes the records, computes their Swarm references, signs each one and hands over one `ffd/batch/1.0` file a day (Notary v1.3, 25 Sep). |
| Sealing service | Takes the batch, checks FFD's signature and each reference, uploads to Swarm, anchors, and assigns sticker ranges. Idempotent: a batch sent twice changes nothing. Mints when FFD says so. |
| Anchor | The record's Swarm reference goes on Ethereum with the time and block number. The Swarm reference *is* a content hash, so that's enough. |
| Newest record per bag | One on-chain entry per packing run: "stickers 4801 to 7800 came from this run", and one more when transport re-points the range. `recordOf(id)` returns the newest; the page walks from there up to the cycles and intakes. |
| NFT | Minted after packing. Default (FFD, 23 Sep): to an FFD custody address, handed over to the sticker addresses when EF legal says so, in batches of about 300. The alternative is minting straight to the sticker. The contract does both. |
| Transfer gateway | A small public server that pays the gas when a holder moves their NFT for the first time. The phone signs with the sticker key, the gateway submits `transferBySig`. It only pays while the NFT is still at its sticker address, so each bag costs at most one transfer. |
| Page | A static page on Swarm, behind a feed manifest: one fixed hash, `GET /bzz/<hash>/`, updatable by the site key. It reads the chain, follows the links, recomputes each Swarm reference in the browser, and compares it with the anchor. Each step links to its Ethereum transaction and its Swarm file. |

One contract: `anchor(ref)`, `anchoredAt(ref)` (time and block), `assign(from, to, ref)`, `assigned(from, to, ref)`,
`recordOf(id)`, `mint(ids, addresses)`, `transferBatch(ids, addresses)`, `transferBySig(id, to, signature)`,
`setBaseURI(uri)`, plus standard ERC-721.

The plant does not run in a straight line (FFD, 23 Sep): one intake can go into two dryer cycles, one
cycle can hold two intakes, and a packing run can take trays from two cycles. Linked records describe
that; a single lot id per bag cannot.

## What the page shows

In FFD's website style: one card per step with readable values ("100 kg", "46 h", "−38.2 °C"),
"Measured by machine" or "Typed by staff", a banner when records are illustrative, a ✓ or ✗ against
the anchor, buttons for the Ethereum transaction and the Swarm file, and the raw record on request.
Then the NFT:

| State | Condition |
|---|---|
| Not packed | no packing run for this id yet |
| Packed | verified records, NFT not minted yet |
| Held by Fair Food Data | NFT owner is the custody address in `config.json` |
| Yours | NFT owner equals the sticker key's address |
| Moved | NFT owner is anyone else |

## What we changed from the spec, and why

| Spec | Brief | Why |
|---|---|---|
| Canonical JSON (RFC 8785) + keccak event hash + Swarm ref in every anchor | Swarm ref only | A Swarm reference is already a hash of the bytes. The page recomputes it locally (tested: gateway reference = local BMT hash). No canonicalization and no encoding debate. |
| Growing `lot.json`, a feed per lot, `openLot`, one lot per production day | One upload per event, each naming the records it came from | Nothing needs a mutable pointer, and the plant mixes intakes across cycles and runs. |
| Two contracts, three roles, Safe | One contract, one owner | Every write happens from the same machine, so splitting keys on it protects nothing. In production: one key for the contract and the site feed, then `renounceOwnership()` after the last write, which freezes the contract for good. |
| The Notary uploads, anchors, assigns and mints | The Notary stops at a signed daily batch; the sealing service does the rest | FFD's decision (v1.3, 25 Sep). The Swarm and Ethereum part already existed in this repo. |
| Mint 15,000 into custody before production, hand over one week before Devcon while gas ≤ 2 gwei | Mint after packing, into custody by default | Nothing is minted for a bag that was never packed, and there is no fee ceiling to wait for. Measured on anvil, batches of 300: 26 k to mint into custody, 34 k for the hand-over, 60 k per bag together, and 61 k with 100 ranges on chain, so the cost stays flat. For 15,000 bags that is about 900 M gas, ≈ 1.8 ETH at 2 gwei or ≈ 0.06 ETH at today's 0.06 gwei. `sealLots`, `burnFromCustody` and the hand-over list are still gone. |
| Custody held by the contract or the Safe | Custody is a plain address, held on a cold key | The server key mints, the cold key hands over with `transferBatch`, which moves only the caller's own tokens and needs no role. |
| Nothing published at printing | The (id, address) list is sealed and anchored at printing | FFD's ask: the hand-over can then be checked against exactly what was printed. Addresses only, never keys. |
| Relay service designed for after Devcon | `transferBySig` plus a gateway in this repo | Without it a holder needs ETH at the sticker address to move the NFT. It still needs a host and a capped key. |
| Base58 key | Hex key | Simpler. Switch to base58/base64url if the QR gets too dense at 20 mm. |

## What we kept

- The key stays in the URL fragment and the server never sees it. Keys are destroyed after printing, and FFD keeps only `id → address`.
- The page is static and there's no FFD server in the read path.
- Swarm first, then Ethereum: an event is anchored only after it has been uploaded.
- Stickers are printed before production. Nothing printed depends on a contract address or a Swarm reference.

## Real risks, in order

1. **Plant data.** None of this matters if the Indian plant doesn't produce real events on time. The fallback is an event clearly labelled `illustrative`. Still open: whether the India dryers are connected to the plant system at all.
2. **Who runs the sealing service.** It holds the contract owner key, needs gas, a Bee node and a postage batch, and has to be up every day from the first production day.
3. **The Swarm gateway under load.** 15,000 phones on one venue network hitting the public gateway. Ask Swarm about rate limits, or keep a second gateway in `config.json`.
4. **Who runs the transfer gateway.** It needs a host and a funded key.
5. **The page is the trust root.** Whoever controls `fairfooddata.org` or the site's feed controls the code that reads the key. Lock down DNS.
6. **Copied keys.** Anyone who photographs a QR owns that NFT. That's acceptable because the NFT holds no value. Whoever moves it first wins, and the gateway pays for that one move.

## PoC in this repo

Live on Sepolia: contract [`0x8ffdf985…afbf4`](https://sepolia.etherscan.io/address/0x8ffdf98526261e121835ecb580561270788afbf4), page at
`https://bzz.limo/bzz/21b029125cbdbd9947ed7076a42d09e0abf76bacd14e48d94d792ab147ac7652/p.html`, FFD's nine records sealed from the v1.3 example batch.

- `contracts/FairFood.sol`: anchors (each ref once, with time, block and an event), sticker ranges, batch transfer, signature transfer, optional base URI, ERC-721.
- `src/sealer.ts`: the sealing service. `batch <file>` from the CLI, or `POST /v1/batches` and `GET /v1/batches/{id}` behind a bearer token.
- `src/site.ts`: uploads `dist/` to Swarm and points the site feed at it.
- `src/cli.ts`: `deploy`, `site`, `stickers`, `seal`, `assign`, `mint`, `handover`, `custody`, `signer`, `batch`, `sealer`, `gateway`, `scan`.
- `src/gateway.ts`: the transfer gateway. Own key, refuses to run on the contract owner's. Checks the NFT is still at its sticker address, checks the signature, then pays. CORS and preflight for the page.
- `web/p.html`: the bag page.
- `plant-fixtures/`: FFD's nine records, schema `ffd/event/1.0`: lot A straight, lot B mixed, one transport per run.
- `notary-v1.3/`: FFD's batch handoff, schema and example batch.
- `test/e2e.ts`: on anvil with real bzz.limo uploads. Both lots by hand through transport, custody, corrections and the gateway; then FFD's batch through the CLI and the HTTP service, including a forged signature.

```sh
npm install
npm test                                  # anvil + bzz.limo, end to end
anvil &                                   # or any testnet RPC below
export PRIVATE_KEY=0x…                    # deployer and owner
forge build && npm run cli deploy http://127.0.0.1:8545 https://bzz.limo http://localhost:5173/p.html
npm run cli site                          # build, upload, update feed; prints the fixed page URL
npm run cli stickers 1 21                 # prints sticker URLs; keeps only id → address in data/
npm run cli seal data/stickers.json        # anchor the printed list
npm run cli signer 0x…                     # FFD's batch signer; without it, ffd.signer in ENS
npm run cli batch notary-v1.3/example/batch-fixtures.json   # needs real signatures
SEALER_TOKEN=… npm run cli sealer 8090     # the same, as POST /v1/batches
npm run cli seal plant-fixtures/intake-a.json     # or by hand: prints its Swarm reference
npm run cli seal plant-fixtures/cycle-a.json <intake ref>
npm run cli seal plant-fixtures/run-a.json <cycle ref>
npm run cli assign 1 10 <run ref>
npm run cli custody 0x…                    # the custody address, for the page's fifth state
npm run cli mint 1 10 0x…                  # into custody; without the address, straight to the stickers
CUSTODY_KEY=0x… npm run cli handover 1 10  # batch transfer to the sticker addresses
npm run cli seal plant-fixtures/transport-a.json <run ref>
npm run cli assign 1 10 <transport ref>    # newest assignment wins
GATEWAY_KEY=0x… npm run cli gateway 8080   # pays for first transfers; POST {id, to, signature}
npm run dev                               # open a printed sticker URL
```
