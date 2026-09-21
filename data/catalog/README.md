# Seed catalog

These files are a curated starter catalog in **FragDB's exact export format** (pipe-delimited,
release v5.x field encodings), so the app's FragDB loader reads them exactly as it would read a
licensed FragDB export:

| File | Contents |
|---|---|
| `fragrances.csv` | one row per fragrance, all 30 FragDB columns |
| `notes.csv` | `id\|name\|group` - note ids referenced by `notes_pyramid` |
| `accords.csv` | `id\|name` - accord ids referenced by `accords` |
| `brands.csv` | `id\|name\|country` |
| `extensions.csv` | `pid\|price_tier\|tags` - **not part of FragDB**; absolute price tier and use-case tags |

Generated from `data/seed-src/*.json` by `npx tsx src/catalog/seedConvert.ts`. Edit the JSON and
regenerate; do not hand-edit the CSVs.

## Provenance and accuracy

- **Identity and composition** (name, brand, launch year, perfumers, gender target, note pyramid,
  accords, price tier) were authored per market segment and then checked by an independent
  fact-checking pass that corrected errors and removed anything it could not confirm.
- **Descriptions, pros and cons** are original wording, not copied from Fragrantica, brands or
  retailers.
- **Community-vote distributions** (season, day/night, gender perception, longevity, sillage,
  value for money, appreciation, rating and vote counts) are **estimates of broad community
  consensus, not real FragDB counts**. Their proportions are what drive recommendations, and they
  are plausible, but they are not measurements. `pid`s start at 900001 so they can never be
  confused with real FragDB/Fragrantica ids.
- `url` and `main_photo` are intentionally empty (the UI shows a monogram tile instead).

To use real data, set `CATALOG_SOURCE=csv` with a licensed FragDB CSV export - see the main README.
(`CATALOG_SOURCE=api` is not usable yet.)
