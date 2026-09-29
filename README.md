# Sealer

The on-chain half of Fair Food Data's bag story. A bag of freeze-dried fruit carries a QR. Scan it and the phone shows where the fruit came from (intake, freeze-drying, packing, transport) and proves none of it was changed later. The bag also comes with an NFT that belongs to whoever holds the sticker.

This repo holds the contract, the command line that uploads and anchors records, and the page the phone opens. FFD's Notary, which composes and signs the records, lives in [`FFD-Labs/notary`](https://github.com/FFD-Labs/notary).

## How it fits together

```
plant events ──► Notary (FFD) ──► envelope ffd/batch/1.0 ──► Sealer ──► Swarm  (the records)
                                   signed per record                └──► Ethereum (anchors, ranges, NFTs)
                                                                                   ▲
                                                              phone page reads both ┘
```

| Piece | What it is |
|---|---|
| Record | One JSON per plant event, uploaded to Swarm. Its Swarm reference is the hash of its bytes. Each record names the records it came from in `inputs`, so the story is a chain. |
| Contract | `FairFood.sol`, an ERC-721 with three jobs: `anchor` a reference with its timestamp, `assign` a sticker range to a reference, and mint and move the bag NFTs. |
| Sticker | A URL printed as a QR: page, network, contract, bag number and a fresh private key. Everything after `#` never leaves the phone. |
| Page | `web/p.html`. Asks the contract for the bag's latest record, walks the chain back through Swarm, checks every reference against its anchor, and shows who holds the NFT. Talks only to Ethereum and Swarm. |
| Envelope | What the Notary hands over: the day's records in order, each signed by FFD. The Sealer checks the signer against its config, or against `ffd.signer` on `fairfooddata.eth` on mainnet. |

## Setup

Node 22 and Foundry.

```bash
npm install
forge build
```

Keys are passed as environment variables and never stored here. `PRIVATE_KEY` is the contract owner; `CUSTODY_KEY` holds the NFTs until hand-over; `GATEWAY_KEY` pays first transfers.

## Commands

All through `npm run cli <command>`.

| Command | What it does |
|---|---|
| `deploy [rpc gateway site]` | Deploys the contract and writes `web/public/config.json` |
| `custody <address>` / `signer <address>` | Sets the custody address and FFD's signing address in the config |
| `site` | Builds the page and publishes it to Swarm under a feed owned by `PRIVATE_KEY` |
| `stickers <from> <to>` | Prints one sticker URL per bag and writes their addresses to `data/stickers.json` |
| `seal <file> [parent refs]` | Uploads a record and anchors its reference; parents go into `inputs` |
| `assign <from> <to> <ref>` | Points a sticker range at a record |
| `mint <from> <to> [custody]` | Mints the NFTs of one packed range, to custody or straight to the stickers |
| `handover <from> <to>` | Moves NFTs from custody to each sticker's address, with `CUSTODY_KEY` |
| `batch <file>` | Seals a whole envelope: signature, reference, upload, anchor, assign; skips what is already anchored |
| `sealer [port]` | The same over HTTP, with a bearer token |
| `gateway [port]` | Pays the gas for a holder's first transfer to their own wallet |
| `scan <url>` | What the page does, on the command line |

## Config

`web/public/config.json`, written by `deploy` and shipped with the page:

| Field | |
|---|---|
| `rpc`, `gateway`, `site` | Ethereum RPC, Swarm gateway, page URL |
| `contract`, `custody`, `signer` | The contract, the custody address, FFD's signing address |
| `postage` | Optional. A Swarm postage batch id; without it, uploads rely on the gateway's stamp |
| `rpcs` | Optional. Chain id to RPC, for stickers on another network |
| `contracts` | Optional. Other contracts the page accepts as FFD's |

## Sticker URL

```
<page>#<chainId>:<contract>/<id>.<key>
```

The page also reads the first format, `<page>#<id>.<key>`, taking the contract from its config. A QR whose contract is not FFD's shows a warning and nothing else.

## Test

```bash
npm test
```

Runs the two end-to-end tests against a local Anvil chain: two lots from sticker to scan, and an envelope through the sealing service.

## Status

Sepolia, phase 0: the Sealer runs on FFD's own laptop with FFD's keys and contract. Nine test records match the reference hashes, twenty NFTs minted to custody, ten handed over, FFD's signed envelope accepted. Production follows on Ethereum mainnet before Devcon 8 (Mumbai, 3 to 6 November 2026).

## Test records

`plant-fixtures/` holds the nine reference records, all marked `illustrative`. Sealed in order, they must produce these references: intake-a `0x9453028f…`, cycle-a `0x37c50aaa…`, run-a `0xb27fc768…`, intake-b `0x16ba91bb…`, cycle-b1 `0x597ac727…`, cycle-b2 `0xa269f3c7…`, run-b `0x796348e9…`, transport-a `0x8a2b87f3…`, transport-b `0x6e7dfb40…`.
