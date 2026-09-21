# Third-party notices

## FragDB sample data - `tests/fixtures/fragdb-sample/`

The four files in `tests/fixtures/fragdb-sample/` (`fragrances.csv`, `notes.csv`, `accords.csv`,
`brands.csv`, 10 records each) are the unmodified sample files from
[FragDB/fragrance-database](https://github.com/FragDB/fragrance-database) (`samples/`, release v5.16),
by **FragDB** - [fragdb.net](https://fragdb.net).

They are licensed under the
[Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/),
**not** under this project's MIT license. In particular, they may not be used for commercial purposes.

They are used only by the test suite, to check that the FragDB parser reads real FragDB export data.
The application itself does not need them: it runs on the bundled seed catalog in `data/catalog/`,
which was written for this project and is covered by the MIT license. If you need a repository that is
MIT throughout (e.g. for commercial use), delete `tests/fixtures/fragdb-sample/` and the tests that read it
(`tests/fragdb.test.ts`, `tests/catalog.test.ts`, and the CSV case in `tests/loader.test.ts`).

## Other services

This project calls, but does not include, [TypeSafe Jev](https://typesafe.ai) (directly or via
[OpenRouter](https://openrouter.ai)) and optionally the [FragDB](https://fragdb.net) Data API. Use of
those services is governed by their own terms.
