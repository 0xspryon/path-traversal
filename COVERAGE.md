# Coverage report

Does `pt-full.yml` semantically cover the public LFI corpus?

**21,130 of 21,132 `(resolved target, technique class)` pairs. Two gaps, both the
same eccentric source line counted under two classes.**

The wordlist is **99,111 payloads**, of which **147 (0.15%)** are the verbatim
passthrough — the measure of how much of the real world the generative model
cannot express.

The corpus ships split across five per-platform categories
(`templates/{linux,windows,macos,language,devops}/`), and that split is now the
tool's primary interface: the default config reads three of the five, and which
three is a recon decision. §3 measures it.

## What this document is measured against

Every figure below comes from a run on **2026-10-01** against commit `e028b32`
plus the two reclassifications described in §3.2, which were in the working tree:
`templates/` as `scripts/harvest-wordlists.ts` writes it, `pt-full.yml` as it
ships, and the 20 cached sources in `.cache/wordlists/`.

Re-running the harvest on that date rewrote every file in `templates/`
**byte-identically** to what was already on disk, so the templates, the sources and
the classifier agree.

This is a dated artifact in one specific sense: the numbers are a function of the
template files and the strategy list, and **any change to either invalidates them**
— a new harvested source, a new curated target, a new or removed strategy entry, a
line moved between categories. That is not a licence to leave figures wrong.

### Reproduce it

One command regenerates every figure in this document, in about a minute:

```sh
bun run scripts/harvest-wordlists.ts \
  && pt --config ./pt-full.yml --dry-run \
  && pt --config ./pt-full.yml \
  && bun run scripts/coverage-check.ts \
  && bun test
```

In order: fetch and decompose the 20 public lists into `templates/<category>/`;
report what each strategy and each input line contributes (§11); write
`wordlist/pt_full_wordlist.txt`; print the coverage table and the gaps (§5–§7);
and confirm nothing functional moved (§12).

`coverage-check.ts` takes `--wordlist`, `--reference`, `--raw` and `--strict`
(which exits 1 on any gap, for CI). The variant configurations in §7, §8 and §9
were measured by generating a modified config to a separate file and pointing
`--wordlist` at it.

A figure here that disagrees with that command is a bug in this file, not a
caveat.

---

## 1. Sources

Twenty lists from two actively maintained corpora. Every URL is in
`SOURCES` in `scripts/harvest-wordlists.ts`, was fetched, and is cached under
`.cache/wordlists/`.

```
source                                          lines   cmt    dec   raw  drop
LFI-Jhaddix.txt                                   930     0    844     0    86
LFI-LFISuite-pathtotest-huge.txt                 9551     0   9551     0     0
LFI-LFISuite-pathtotest.txt                       569     0    569     0     0
LFI-linux-and-windows_by-1N3@CrowdShield.txt     1156     0   1152     0     4
LFI-etc-files-of-all-linux-packages.txt          8315     0   8315     0     0
LFI-gracefulsecurity-linux.txt                    881     0    877     0     4
Windows-LFI-Payloads_by-adeadfed.txt              215     0    187     4    24
Windows-Paths.txt                                5270     0   5259     0    11
patt-Linux-files.txt                               62     0     62     0     0
patt-Windows-files.txt                            212     0    212     0     0
patt-BSD-files.txt                                 13     0     13     0     0
patt-Mac-files.txt                                  8     0      8     0     0
patt-Web-files.txt                                 14     0     14     0     0
patt-LFI-FD-check.txt                              39     0     39     0     0
patt-LFI-WindowsFileCheck.txt                      69     0     69     0     0
patt-List_Of_File_To_Include.txt                  911     0    909     0     2
patt-Traversal.txt                               4520    10   4370   135     5
patt-directory_traversal.txt                      140     0    130     7     3
patt-deep_traversal.txt                           912     0    884    28     0
patt-traversals-8-deep-exotic-encoding.txt        887     0    859    28     0
TOTAL                                           34674    10  34323   202   139
```

Every line lands in exactly one of four places and all four are counted:
**34,323 decomposed** into the four slots, **202 routed verbatim** to a
`<category>/raw.txt` (147 after deduplication), **139 discarded** as corrupt or
unparameterisable, and **10 comment lines** skipped. Nothing is dropped silently.

Correctness is checked rather than asserted: every candidate decomposition is
reassembled by **calling `assemble` itself**, and anything that does not rebuild
byte-identically is routed to `raw` instead of into a slot file. No template line
is a guess, and the round-trip check cannot drift from what the generator emits.

The `patt-` prefix marks **PayloadsAllTheThings**, the one source beyond SecLists.
It earns its place by adding material SecLists has none of: BSD and macOS targets
(`/usr/pkg/etc/httpd/httpd.conf`, `/Library/WebServer/Documents/`,
`/private/var/log/appstore.log`) and the exotic traversal encodings — of the 185
harvested traversal primitives, **18 carry a `%uXXXX` escape** and **16 a `%%NN`
nested percent**, and all 34 come from this repository.

### Source selection, recorded from the selection pass

The two notes below are about which URLs are in `SOURCES`, not about pt's state.
They were established when the source list was chosen and have **not** been
re-fetched for this run; what is re-verified is only that the list in
`scripts/harvest-wordlists.ts` matches them.

* **`php-filter-iconv.txt` is deliberately excluded.** It is cached (49 lines) and
  the string `php-filter-iconv` does not appear anywhere in
  `scripts/harvest-wordlists.ts`. Its lines are
  `convert.iconv.CP1390.CSIBM932` filter-chain components, not paths, and they
  cannot stand in any slot.
* **Assetnote has no LFI or traversal list.** Its CDN's 522s are an origin failure
  affecting the whole CDN, including the directory root from Assetnote's own `wget`
  instructions — not a signal about guessed paths. The authoritative index
  (`data/{automated,manual,kiterunner,technologies}.json`, all HTTP 200) lists 74
  files, none matching `lfi|traversal|dotdot|passwd|path.?to|include|dirtrav`.
  Their README confirms the scope: content and subdomain discovery. Nothing was
  substituted for it.

---

## 2. Data quality

```
discarded by reason:
  corrupt:stripped-percent             75
  unusable:placeholder                 38
  corrupt:space-in-token               14
  corrupt:markup                       10
  corrupt:truncated-escape              2
```

* **75 `corrupt:stripped-percent`**, all in `LFI-Jhaddix.txt` — the file has
  exactly 75 lines matching `\.\.2f`.
  `..2f..2f..2fusr2flocal2fapache2flogs2faccess_log` is not a traversal in any
  encoding; it is a filename containing the characters `2f`.
* **14 `corrupt:space-in-token`.** Separating these from real filenames took care:
  **3,844 of `Windows-Paths.txt`'s 5,270 lines contain a space**, and essentially
  all of them are legitimate — 2,788 are `Program Files` or `Documents and
  Settings`, and the other 1,056 are paths like `C:\ProgramData\Microsoft\Device
  Stage\…` and `C:\MySQL\MySQL Server 5.0\data\hostname.err`. So the rule had to
  be narrow, not broad. Three rules do it, each anchored on a character that
  cannot legally neighbour a space — a space next to `_` (`access_ log`), a space
  inside a percent escape (`…%  25%5c..`), and a space right after a dot
  (`access. log%00`). 14 lines out of 3,844 is the whole yield.
* **38 `unusable:placeholder`** — `{IPDELHOST}`, `{DOMAIN}`, `{HOST}` and the bare
  `RANDOMDIR` convention.
* **10 `corrupt:markup`** — `=3D`, `&apos;`, smart quotes, U+2026. Publishing
  artefacts, e.g. Jhaddix line 25, which reads `=3D “/..” . “%2f..`.
* **2 `corrupt:truncated-escape`** — lines cut off mid-escape (`…%25%5c..%`).

`{FILE}` is **not** discarded. Those **1,799** lines are traversal templates and
are the richest source of primitives in the corpus; the decomposer takes their
traversal and drops the placeholder rather than filing it as a target. One
consequence is worth stating plainly, because it is visible in the output: a line
that goes to the **passthrough** keeps its placeholder, so **56 of the 147
passthrough lines contain a literal `{FILE}`** and exactly 56 payloads in the
generated wordlist therefore carry that text. They are in the file for their
traversal shape, and as payloads they are inert.

### The template files

28 files. The five category folders hold the harvested and curated corpus; seven
files at the `templates/` root are the small *sizing* files `pt-full.yml` pairs the
big ones with, cross-category by construction.

| file | entries | what it is |
| --- | --- | --- |
| `linux/target.txt` | 8,473 | `/etc`, `/proc`, `/var/log`, `/root`, shells, SSH — plain POSIX |
| `windows/target.txt` | 5,961 | Win32 paths, registry hives, IIS, UNC |
| `devops/target.txt` | 871 | web/app servers, data stores, k8s, Docker, IaC, CI/CD, cloud, AI tooling |
| `language/target-php.txt` | 419 | PHP |
| `language/target-perl.txt` | 41 | Perl |
| `language/target-java.txt` | 22 | Java / JVM |
| `language/target-node.txt` | 20 | Node |
| `language/target-python.txt` | 19 | Python |
| `language/target-dotnet.txt` | 14 | .NET / IIS-hosted |
| `language/target-ruby.txt` | 12 | Ruby |
| `macos/target.txt` | 61 | `/System`, `/Library`, `/Users`, keychains, launchd, Homebrew |
| `linux/traversal.txt` | 93 | `/`-class primitives, trailing-separator form |
| `windows/traversal.txt` | 91 | `\`-class primitives |
| `language/traversal-java.txt` | 1 | `..;/` — a servlet container strips `;…` from a path segment |
| `windows/prefix.txt` | 30 | Win32 device/UNC preludes, IIS and XAMPP document roots |
| `linux/prefix.txt` | 13 | separator padding, leading null bytes, `%0a` |
| `devops/prefix.txt` | 9 | document roots a web or application server maps |
| `language/suffix.txt` | 10 | null bytes, fake extensions, `?` and `#` truncators |
| `windows/suffix.txt` | 2 | `.` and `.......` — Win32 strips trailing dots |
| `windows/raw.txt` | 95 | the verbatim passthrough, `\`-class (§9) |
| `linux/raw.txt` | 52 | the verbatim passthrough, `/`-class (§9) |
| `target-hot.txt` | 873 | targets the corpus pairs with more than a bare path — *derived* |
| `target-encoded.txt` | 94 | targets the corpus writes with a respelled separator, stored in literal spelling — *derived* |
| `target-core.txt` | 39 | the files worth spelling in every encoding |
| `traversal-core.txt` / `-min.txt` | 8 / 2 | what the big files get paired with |
| `target-padding.txt` | 3 | `/etc/passwd`, `/proc/self/environ`, `/.env` — what `padding:2048` runs against |
| `empty.txt` | 0 | a real empty file, kept for compatibility — `slot=` in an override now says the same thing |

**17,328 payload lines in total**, of which 147 are the passthrough, so 17,181 are
slot inputs — which is exactly what `--dry-run` reports as the denominator of its
per-input table. That is a cross-check, not a coincidence: if a file were being
read twice or not at all, the two numbers would disagree.

Two cautions when counting these yourself, both of which bit this report's own
cross-checks:

* **`target-encoded.txt` is binary to `grep`.** 28 of its 94 lines contain a
  literal NUL byte, so GNU grep classifies the file as data, suppresses output and
  exits 1 — a plain `grep -c` returns *nothing*, not a count:

  ```
  $ grep -c . templates/target-encoded.txt ; echo "exit=$?"
  exit=1
  $ grep -ac . templates/target-encoded.txt ; echo "exit=$?"
  134
  exit=0
  ```

  (134 is lines-including-comments; the payload count is 94.) It is the only file
  in `templates/` that grep treats as binary. Use `grep -a`.
* **`#.png` is a payload, not a comment.** pt treats `#` as a comment only when it
  is followed by whitespace, by another `#`, or by nothing — `isCommentLine` in
  `src/core/lines.ts`. A naive `^#` filter silently eats `#.png`, line 33 of
  `language/suffix.txt`, and reports that file as 9 entries. It is 10, and the
  suffix dimension is 12.

---

## 3. The per-platform split

The corpus is not one list. It is five, one per stack dimension, and choosing
among them is the decision pt exists to support: you fingerprint the target, then
assemble a wordlist out of the folders that match what you found. A flat corpus
cannot express that choice.

```
templates/windows/    Win32 paths, registry hives, IIS, UNC, '\' primitives
templates/macos/      /System, /Library, /Users, keychains, launchd, Homebrew
templates/linux/      /etc, /proc, /var/log, /root, shells, SSH, POSIX
templates/language/   one file per runtime: PHP, Java, .NET, Python, Node, Ruby, Perl
templates/devops/     nginx, tomcat, k8s, docker, terraform, CI/CD, cloud, AI
```

`scripts/categorize.ts` assigns every harvested line to exactly one of the five.
First match wins and no entry is written twice, so the folders are a **partition**
of the corpus rather than five overlapping views.

### 3.1 The two classification rules

**1. An OS-rooted path beats a stack marker.** `C:\xampp\php\php.ini` names PHP,
but the path only resolves on Windows, so it is a Windows target;
`/Volumes/Macintosh_HD1/usr/local/php/lib/php.ini` is macOS for the same reason.
Recon establishes the OS before the runtime, and the OS is the half that makes the
path syntactically impossible anywhere else.

**2. Otherwise the most specific stack component wins**, where specific means
**runtime → infrastructure → distro**. `/etc/php/8.3/cli/php.ini` is PHP,
`/etc/nginx/nginx.conf` is nginx, `/etc/passwd` is just Linux. A path should live
in the folder you reach for after fingerprinting that one thing.

So the match order is `windows → macos → language → devops → linux`, with `linux`
as the fallback. Two guards keep rule 1 from over-reaching: a syntactic Windows
test (a stray `\`, a leading `//`) does not fire on a POSIX-rooted path, so
`.\./.\./..//etc/passwd` and `//etc/passwd` stay Linux targets wearing Win32
noise; and the macOS roots are anchored, because unanchored `/library` and
`/system` claim `/etc/selinux/…/users/` and `/etc/samba/private/smbpasswd`.

Prefixes, traversals, suffixes and raw entries are **not** classified by path —
they are classified by **separator identity**, because for those slots that is the
only dimension their entries differ in. A `\`-class separator in any spelling
(`\`, `%5c`, `%c1%9c`, `%ef%bc%bc`, `%%35%63`) means the payload is aimed at Win32
path parsing; `/`-class is POSIX. The document roots in `devops/prefix.txt` are
the one hand-assigned exception, for the reason in 3.2.

### 3.2 Two reclassifications this revision carries

Both were rule-2 violations — a path classified by the stack it is *usually seen
with* rather than by what it *is* — and both are net-zero on every dimension
total, because a partition that moves a line between folders cannot change how
many lines there are.

**`.htaccess` / `.htpasswd`: `language/target-php.txt` → `devops/target.txt`.**
They are Apache's files. They merely happen to appear most often on LAMP stacks,
and classifying them as php both contradicted rule 2 and split them from the rest
of the Apache configuration they belong with. 25 lines moved.

**`/var/www/html/` and `/var/www/images/`: `linux/prefix.txt` →
`devops/prefix.txt`.** A document root is server configuration wherever it happens
to sit on disk, which is what already put `/usr/share/nginx/html/` and `/var/www/`
in `devops/`. `/var/www/` being curated into `devops/` while `/var/www/html/` sat
in `linux/` was the same value in two folders. 2 lines moved, and the `/var/www`
marker that followed also pulled `/var/www/conf`, `/var/www/.bash_history` and
`/var/www/sitename/htdocs/` out of `linux/target.txt`. A `.php` file *under* a
docroot is still php: the language rules run first.

| file | before | after |
| --- | --- | --- |
| `language/target-php.txt` | 444 | **419** |
| `linux/target.txt` | 8,476 | **8,473** |
| `devops/target.txt` | 843 | **871** |
| target dimension | 15,913 | **15,913** — unchanged |
| `linux/prefix.txt` | 15 | **13** |
| `devops/prefix.txt` | 7 | **9** |
| prefix dimension | 52 | **52** — unchanged |

Payload count, coverage and the raw ratio are unchanged by both moves. What
changes is which folder a reader of the recon-first workflow opens to find them —
which is the only thing the split is for.

### 3.3 Per-category line counts

```
dimension accounting (deduplicated values vs lines written):
  dimension   expected  written
  target      15913     15913     [15670 harvested + 243 curated]
  traversal   185       185       [harvested]
  prefix      52        52        [40 harvested + 12 curated]
  suffix      12        12        [harvested]
  raw         147       147       [harvested]
```

| category | target | traversal | prefix | suffix | raw | total | of which curated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `linux` | 8,473 | 93 | 13 | – | 52 | **8,631** | 0 |
| `windows` | 5,961 | 91 | 30 | 2 | 95 | **6,179** | 13 |
| `devops` | 871 | – | 9 | – | – | **880** | 146 |
| `language` | 547 | 1 | – | 10 | – | **558** | 60 |
| `macos` | 61 | – | – | – | – | **61** | 36 |
| root (sizing) | 1,009 | 10 | – | – | – | **1,019** | 0 — *derived* |
| **TOTAL** | **16,922** | **195** | **52** | **12** | **147** | **17,328** | **255** |

The target column in that table exceeds the 15,913-line target *dimension* because
`target-hot.txt`, `target-encoded.txt`, `target-core.txt` and `target-padding.txt`
are measurements **over** the categorised files, not additions to them.

**255 curated lines in 25 headed sections**, 243 of them targets and 12 prefixes.
A curated value the harvest already found is skipped rather than written twice —
16 of them were. The curated sections are routed by the *section*, not by the
classifier, because somebody grouped those lines by technology on purpose and
splitting one across folders by machine would destroy the only thing it had.

### 3.4 What the default config reads

`pt --generate-basic-config` scaffolds **all five** folders and then wires **three**
of them into the slots:

| slot | files the scaffolded config reads |
| --- | --- |
| `prefix` | `linux/prefix.txt` (`devops/prefix.txt` scaffolded, commented out) |
| `traversal` | `linux/traversal.txt`, `repeat: [3, 6, 10, 16]` |
| `target` | `linux/target.txt`, `language/target-php.txt`, `language/target-java.txt`, `devops/target.txt` |
| `suffix` | `language/suffix.txt` |
| `raw_file` | `raw.txt` |

So the default is **linux + language + devops**, and `windows/` and `macos/` ship
scaffolded but **opt-in**, named only in commented-out example lines. That is the
recon-driven decision stated as a default rather than argued for in prose: the
common case is a Linux host running a known runtime behind a known server, and
`prefix` is singled out for the same reason in the other direction — a prefix
multiplies every other slot, so `devops/prefix.txt` is scaffolded and left out
until recon says which document root is real.

Measured, from a clean scaffold into an empty directory and then a generate:

```
$ pt --generate-basic-config ./pt.yml          # into an empty directory
wrote .../pt.yml
wrote .../templates/linux/prefix.txt
wrote .../templates/linux/traversal.txt
wrote .../templates/linux/target.txt
wrote .../templates/language/target-php.txt
wrote .../templates/language/target-java.txt
wrote .../templates/language/suffix.txt
wrote .../templates/devops/target.txt
wrote .../templates/devops/prefix.txt
wrote .../templates/windows/prefix.txt
wrote .../templates/windows/traversal.txt
wrote .../templates/windows/target.txt
wrote .../templates/windows/suffix.txt
wrote .../templates/macos/target.txt
wrote .../templates/linux/raw.txt
wrote .../templates/target-padding.txt

$ pt --config ./pt.yml
169051 unique payloads -> .../wordlist/pt_wordlist.txt
```

Fifteen template files scaffolded, eight of them wired into the slots, and
**169,051 payloads** — each of the 11 strategies emits 19,425 and the passthrough
adds 1, and 169,051 is what survives dedupe. That is under `warn_above: 200000`, so
a clean first run does not warn. Adding `windows/` and `macos/` is what the
commented-out lines are for; uncommenting `devops/prefix.txt` is one line and
multiplies every other slot.

---

## 4. The canonical key

The key is **`(resolved target, technique class)`**. A pair, because the two halves
behave in opposite directions, and getting either one wrong destroys the
measurement.

### Depth collapses into the class

`..` in the root directory is the root itself, so overshooting is free and any
depth covers every shallower one:

```
$ readlink -m /../../../../../../etc/passwd
/etc/passwd
$ readlink -m /var/www/html/../../../../../../etc/passwd
/etc/passwd
```

`resolveClamped()` pops `..` against an empty stack as a no-op — that pop *is* the
clamp. Windows clamps identically. So `../../../etc/passwd` and
`../../../../../../../../etc/passwd` are the same request, depth must not appear in
the key, and `pt-full.yml` ships **one repeat rung** instead of four. This is a
4× saving that costs nothing.

### Encoding completeness does NOT collapse, and this is the trap

A checker that fully decodes each payload maps every variant onto `/etc/passwd`
and then "proves" total coverage while hiding every real gap. Partial and full
encoding are **siblings**, not a subset relation, because they trip different
filter signatures:

| payload | literal `..` | `%2e` | `%2e%2e` | `%2f` |
| --- | --- | --- | --- | --- |
| `../../../etc/passwd` | MATCH | – | – | – |
| `..%2f..%2f..%2fetc%2fpasswd` | MATCH | – | – | MATCH |
| `%2e%2e/%2e%2e/%2e%2e/etc/passwd` | – | YES | YES | – |
| `%2e%2e%2f%2e%2e%2fetc%2fpasswd` | – | YES | YES | MATCH |

Full encoding trips every signature; each partial form trips a strict subset. So
emitting the fully-encoded form does **not** cover a reference entry written in a
partial one. `primaryClass()` therefore inspects literal bytes and never decodes.
Only the *target* half of the key is decoded, by `canonicalTarget()`.

**This is not a theoretical worry — §8 measures it.** Strip the `charset`
strategies and the pre-encoded primitives and `partial-dots` coverage falls to
**0 of 3**. All three of those reference entries resolve to `/boot.ini`,
`/etc/passwd` and `/etc/shadow`, every one of which the same wordlist covers under
`plain`. A checker that decoded before classifying would therefore report all three
as covered, and the `partial-dots` technique — with no coverage whatsoever — would
not appear in its output at all. The non-decoding key is the only reason the gap is
visible.

### The classes

One **primary** spelling, mutually exclusive: `plain`, `partial-dots`,
`partial-sep`, `full-url`, `double-url`, `triple-url`, `overlong`, `fullwidth`,
`percent-u`, `nested-percent`, `base64`, `absolute-no-traversal`.

Plus any number of **orthogonal features**: `backslash`, `noise-dot`,
`noise-slash`, `semicolon`, `null-byte`, `trailing-ext`, `trailing-dot-space`.

---

## 5. Coverage table

```
reference corpus   .cache/wordlists/reference-corpus.txt
                   34664 lines, 34525 usable (corrupt lines skipped)
pt wordlist        wordlist/pt_full_wordlist.txt
                   99111 payloads, of which 147 verbatim from raw_file

canonical key      (resolved target, technique class)
                   depth COLLAPSES into the target -- '..' at '/' is '/'
                   encoding does NOT collapse -- partial and full are siblings

reference pairs     21132
pt pairs            30689
```

| class | ref | covered | gap | pct |
| --- | --- | --- | --- | --- |
| **primary spelling (mutually exclusive)** | | | | |
| `plain` | 283 | 283 | 0 | 100.0% |
| `partial-dots` | 3 | 3 | 0 | 100.0% |
| `partial-sep` | 5 | 5 | 0 | 100.0% |
| `full-url` | 5 | 5 | 0 | 100.0% |
| `double-url` | 7 | 7 | 0 | 100.0% |
| `triple-url` | 0 | 0 | 0 | – |
| `overlong` | 3 | 3 | 0 | 100.0% |
| `fullwidth` | 3 | 3 | 0 | 100.0% |
| `percent-u` | 2 | 2 | 0 | 100.0% |
| `nested-percent` | 4 | 4 | 0 | 100.0% |
| `base64` | 5 | 5 | 0 | 100.0% |
| `absolute-no-traversal` | 14,587 | 14,587 | 0 | 100.0% |
| **orthogonal features** | | | | |
| `backslash` | 5,145 | 5,145 | 0 | 100.0% |
| `noise-dot` | 5 | 5 | 0 | 100.0% |
| `noise-slash` | 13 | 13 | 0 | 100.0% |
| `semicolon` | 2 | 2 | 0 | 100.0% |
| `null-byte` | 324 | 323 | **1** | 99.7% |
| `trailing-ext` | 263 | 262 | **1** | 99.6% |
| `trailing-dot-space` | 473 | 473 | 0 | 100.0% |
| **TOTAL** | **21,132** | **21,130** | **2** | **100.0%** |

The shape of that table is the shape of the corpus: `absolute-no-traversal`
accounts for 14,587 of the 21,132 pairs, and the nine respelling classes together
account for 32. The corpus is overwhelmingly a list of **filenames**, with a thin
layer of encoding tricks on top. That asymmetry is what sizes `pt-full.yml` (§11).

Stated precisely, over the 14,610 distinct resolved targets in the corpus:

| | targets |
| --- | --- |
| appear **as** a bare absolute path (`absolute-no-traversal`) | 14,587 |
| never appear as a bare absolute path at all | 23 |
| appear **only** as a bare absolute path, with no other class at all | 9,117 |
| appear with some primary class other than `absolute-no-traversal` | 293 |
| appear with a **respelling** primary class (one of the nine) | **16** |

Sixteen. The whole encoding layer of the public corpus is sixteen targets, written
in nine spellings, totalling 32 of 21,132 pairs. Everything else is a filename
with at most a null byte or a fake extension on the end.

---

## 6. Coverage per category

Coverage decomposes cleanly along the split, because the two halves of the key come
from different places: **a category supplies targets, and a strategy supplies
classes.** No category carries a technique class of its own. So the honest
per-category measurement is *target reach* — how much of the reference corpus each
folder's target file can ask for at all.

| category | target lines | distinct resolved | in the reference | ref pairs at those targets | share of 21,132 |
| --- | --- | --- | --- | --- | --- |
| `windows` | 5,961 | 5,140 | 5,138 | 10,588 | 50.1% |
| `linux` | 8,473 | 8,264 | 8,264 | 8,760 | 41.5% |
| `devops` | 871 | 862 | 724 | 1,137 | 5.4% |
| `language` | 547 | 536 | 476 | 679 | 3.2% |
| `macos` | 61 | 61 | **25** | 73 | **0.3%** |
| all five | 15,913 | – | **14,607** of 14,610 | **21,119** | 99.9% |

The shares sum above 100% because the folders partition the **lines**, not the
resolved targets: two differently-spelled lines in two folders can resolve to the
same file. 20 reference targets are claimed by more than one category — 118 pairs —
e.g. `/etc/passwd` appears both as a plain POSIX path in `linux/` and inside a
`\`-separated Win32 payload in `windows/`, and `/web.config` is both a .NET marker
and an IIS one.

`windows` out-reaches `linux` on *pairs* while reaching fewer targets, because the
Windows half of the corpus is where the orthogonal features live: `backslash` alone
is 5,145 of the 21,132 pairs.

**Three reference targets are in no category target file at all**, and they are
reached through the `prefix` slot instead:

```
/c:/windows/system32/drivers/etc/hosts    6 pairs   (prefix 'C:\WINDOWS\win.ini../')
/?/c:/windows/system32/drivers/etc/hosts  3 pairs   (prefix '//?/')
c:/etc/hosts                              4 pairs   (prefix 'C:\WINDOWS\win.ini../')
```

That is not an accounting curiosity: it is where §7's two remaining gaps live. The
only targets pt reaches by prefix composition are also the only ones for which a
missing prefix × suffix crossing can cost coverage.

### Which categories are thin, and which are curated rather than harvested

Presenting the five as equals would be dishonest. They differ by more than two
orders of magnitude, and two of them are mostly hand-written:

| category | harvested | curated | the honest reading |
| --- | --- | --- | --- |
| `linux` | 8,631 | 0 | entirely harvested; the deepest file in the corpus |
| `windows` | 6,166 | 13 | effectively all harvested: 9 curated registry/IIS targets and 4 curated document roots |
| `devops` | 734 | 146 | harvested web/DB config, plus 14 curated sections the public lists have nothing for |
| `language` | 498 | 60 | PHP (413 of 419) and Perl (41 of 41) are harvested; Java, Python, Ruby and Node are mostly curated |
| `macos` | 25 | 36 | **59% curated.** The public lists are thin here |

* **`macos/target.txt` at 61 lines is not a peer of `linux/target.txt` at 8,473.**
  The split is exact: all **25** harvested lines resolve to a target the reference
  corpus contains, and **0 of the 36 curated ones do**. So 59% of the file has
  nothing to be measured against, and its 0.3% share of the reference pairs is a
  statement about the public wordlists rather than about macOS — the corpus
  contributes eight `patt-Mac-files.txt` lines in total.
* **`language/target-java.txt` at 22 lines is 2 harvested and 20 curated.** Its own
  section header says so: *"the corpus has almost none of this"*. The two harvested
  lines are `/etc/tomcat4/web.xml` and `/root/.ssh/id_rsa.keystore`; everything that
  makes the file useful against a real JVM stack — `/WEB-INF/web.xml`,
  `/META-INF/MANIFEST.MF`, `/WEB-INF/classes/application.properties`, `/.keystore` —
  is there because somebody wrote it down, not because a list was found containing
  it.
* `language/target-python.txt` (19: 4 harvested), `target-ruby.txt` (12: 2) and
  `target-node.txt` (20: 11) are in the same position, at smaller scale.

The right way to read a thin category is that its *coverage number* is small
because the **reference corpus** is thin there, not because pt is. §10 is the other
side of that: the curated sections are deliberately outside the coverage table,
because there is nothing to compare them against.

---

## 7. The two gaps

```
null-byte  (1 of 324 targets uncovered)
    c:/etc/hosts
        reference: C:\WINDOWS\win.ini../../../../../../../../../../../../etc/hosts%00

trailing-ext  (1 of 263 targets uncovered)
    c:/etc/hosts
        reference: C:\WINDOWS\win.ini../../../../../../../../../../../../etc/hosts%00
```

One payload, counted under two classes — confirmed unchanged by this run. Both
halves of it are in the templates — the prefix `C:\WINDOWS\win.ini../` is in
`windows/prefix.txt` and `%00` is in `language/suffix.txt` — but **no block crosses
the prefix slot with the suffix slot**. That is a sizing choice, and the price of
reversing it was measured both ways, by generating each variant and running the
checker against it:

| change | payloads | coverage |
| --- | --- | --- |
| as shipped | 99,111 | 21,130 / 21,132 |
| add the two suffix files to the prefix block | 321,351 | **21,132 / 21,132** |
| add a *separate* prefix × suffix block at `traversal-min` | 172,527 | **21,132 / 21,132** |

So the naive fix is **+222,240 payloads — 3.24× the wordlist** — because the prefix
block is already a 53 × 9 × 39 matrix (52 prefixes plus the empty member, 8
traversal spellings plus the empty member, 39 core targets = 18,603 payloads) and
adding the suffix slot multiplies it by 13. It also trips `warn_above: 250000`:

```
warning: 321,351 payloads exceeds 'limits.warn_above' (250,000).
```

The cheap fix is a dedicated block that holds the traversal down to two spellings:
**+73,416, 74% larger**, and it stays under the warning. Either way it is one line,
and either way it is a lot of wordlist for one eccentric corpus entry. Left open,
documented, measured.

---

## 8. Partial encoding: the hypothesis, tested

The original expectation was that pt would show partial-encoding gaps, on the
grounds that `selective_*` is its only partial-encoding family and only
`selective_last` is enabled by default.

**Refuted as stated, and confirmed in a sharper form.** Four configurations, each
generated and then checked:

| configuration | `partial-dots` | `partial-sep` | `full-url` | payloads |
| --- | --- | --- | --- | --- |
| **A.** `pt-full.yml` as shipped | 3/3 (100%) | 5/5 (100%) | 5/5 | 99,111 |
| **B.** only `selective_last`, no `charset` strategies | 3/3 (100%) | 5/5 (100%) | 4/5 | 95,593 |
| **C1.** B, every traversal primitive not spelled in literal bytes removed | **0/3 (0%)** | 5/5 (100%) | 4/5 | 78,887 |
| **C2.** B, only the 11 `partial-dots` primitives removed | **0/3 (0%)** | 5/5 (100%) | 4/5 | 95,164 |

Configuration B keeps full `partial-dots` coverage, so the premise does not hold as
written. C isolates why, and the answer is more interesting than the hypothesis.
Both readings of C give the same 0/3, which is what makes the result a property of
the strategy catalog rather than an artefact of how the primitives were filtered.

**`partial-sep` was never at risk, because `selective_*` IS that family.**
`selective_last` produces `../../../etc%2fpasswd` — literal `..` present, `%2f`
present — which is exactly the class. It holds at 5/5 in every configuration, and
it holds even with the passthrough removed as well (78,740 payloads, still 5/5),
so this is the strategy layer and nothing else.

**`partial-dots` had no strategy in the catalog at all.** `selective_*` only
treats separators as candidates — `isCandidate: isSeparator` in
`src/core/strategy.ts` — so nothing in the named catalog encoded a dot while
leaving the separator literal. Configuration C shows the result:

```
partial-dots  (3 of 3 targets uncovered)
    /boot.ini
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/boot.ini
    /etc/passwd
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd
    /etc/shadow
        reference: /%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/shadow
```

**The dimension route was masking a missing strategy.** Runs A and B close that
class only because `%2e%2e/`, `%2e%2e%2e%2e//` and `.%2e/%2e%2e/%2e%2e/%2e%2e/`
happen to ship as pre-encoded primitives — **11 of the 185** are `partial-dots`, 8
in `linux/traversal.txt` and 3 in `windows/traversal.txt`. That is the "slot files
supply content, strategies supply spelling" duality doing real work, but relying on
it alone means the class reaches only the targets a harvested primitive is paired
with. In configuration B that is **41 targets**; with the strategy it is **52**.

**The fix needed no new code,** only the per-stage charset argument, and
`pt-full.yml` ships both halves:

```yml
- 'url_encode:1(charset=".")   | target=…'   # %2e%2e/%2e%2e/etc/passwd
- 'url_encode:1(charset="/\\") | target=…'   # ..%2f..%2fetc%2fpasswd
```

Measured, those two lines raise `partial-dots` from 41 to 52 targets and close the
one `full-url` pair that configuration B misses, a 4/5 → 5/5 move in that class as
a side effect. They cost **1,197 payloads each**, with `unique` columns of 949 and
700.

Note that `url_encode:1(charset="/\\")` and `selective_last` are both
`partial-sep` and are **different payloads** — the first encodes every separator,
the second encodes exactly one. Keeping both is the point, and their `unique`
columns (700 and 954) say neither is redundant.

---

## 9. The passthrough: two closures and what is left

`raw_file` bypasses assembly and every strategy. That is correct — real wordlists
contain internally inconsistent lines no generator reaches — but it makes the
passthrough the escape hatch that measures how incomplete the generative model is.
Its size relative to the generated part is the honest number:

```
raw ratio  0.15%  -- 147 verbatim entries against 98,964 generated payloads
  147 of them (100.00%) are reachable ONLY verbatim, which is a raw ratio of
  0.15% against the generated part; the rest some strategy also derives.
```

Those two figures have converged, and that convergence is the most useful thing
the headline has done. They used to read `0.42% -- 398 entries` and `386 of 398
(96.98%)`: the gap between them was lines the passthrough carried for *shape*
reasons alone. There is no such gap now. The passthrough is smaller **and** every
line in it is irreducible.

The 147 lines are split by separator family like every other dimension —
`windows/raw.txt` 95, `linux/raw.txt` 52.

### Closure 1: the non-greedy leading-separator strip

**The technique.** A **doubled junction** — `../../..//etc/passwd` — is a filter
hypothesis in its own right: the stack either counts separators or collapses runs
of them only *after* checking, so a second separator at the junction survives the
check and is normalised away before the open.

**What was wrong.** `strip_leading_separator` looped, removing *every* equivalent
leading separator the target had. So `/etc/passwd`, `//etc/passwd` and
`///etc/passwd` all collapsed onto one payload after a `../`, and the doubled
junction was unreachable at **any** target spelling whatsoever. It was the largest
single expressive gap in the model: 251 of the passthrough's then 398 lines were
that shape and nothing else wrong with them.

**The fix.** The strip now takes **exactly one** separator: the preceding slot
supplies one, the target gives up one, and the rest is the author's. No schema
change was needed — the extra separator was always sitting in the target's own
text, which is why `//etc/passwd` and `//etc/passwd%00index.html` are now ordinary
target lines.

It needed a matching narrowing of the **decomposer**, and that is the half worth
reading. Its step matcher is greedy in exactly the same way, so
`../../..//etc/passwd` parsed as `../ | ../ | ..//` — a clean repetition that
breaks at its last step, which is the signature that routes an entry to the
passthrough *before* any round-trip check runs. A self-check cannot rescue a parse
that was never offered to it. `reflowTail` now hands trailing separators back to
the target when the tail is the established step plus nothing but separator
tokens, and every earlier step is identical.

Measured, across the change. The figures are dimension totals, because the change
predates the category split and the files it moved no longer exist under those
names:

| figure | before | after |
| --- | --- | --- |
| passthrough (`raw` dimension) | 398 | **147** |
| entries routed to raw | 459 | **202** |
| decomposed | 34,066 | **34,323** |
| target dimension | 15,794 | **15,796** |
| traversal dimension | 185 | 185 (no new monolithic primitives) |
| `(target, class)` coverage | 21,130 / 21,132 | 21,130 / 21,132 (unchanged) |

The two new target lines are the doubled junctions. Coverage did not move, which
is the expected result: the shapes were already *counted* as covered through the
passthrough, and what changed is that the generator now expresses them. The target
dimension has since grown from 15,796 to **15,913** through the split's curated
additions, which is a separate change and is accounted for in §3.3.

One side effect worth recording because the risk assessment for the change had
missed it: the four UNC targets (`//localhost/C$/…`, `\\::1\C$\…`) are in
`target-hot.txt`, which two blocks pair with a traversal, so 72 payloads changed
shape — for the better. `../../../localhost/C$/…` had been quietly destroying the
`//` that makes a UNC path a UNC path, and it now survives as
`../../..//localhost/C$/…`. Payload count was identical and coverage did not move.

### Closure 2: `utf16_escape` and `double_percent`

Two technique classes fell out of the corpus that the catalog could not spell, and
that pt reached only because the harvested traversal files happened to contain
primitives already written that way:

| strategy | mapping | hypothesis |
| --- | --- | --- |
| `utf16_escape` | `/`→`%u2215`, `\`→`%u005c` | the server resolves the non-standard `%uXXXX` form, and the filter has no rule for it at all |
| `utf16_escape(codepoint="2044")` | `/`→`%u2044` | the same bet on U+2044 FRACTION SLASH instead of U+2215 DIVISION SLASH |
| `double_percent` | `/`→`%%32%66`, `\`→`%%35%63` | two decodes happen after the check, and `%25` — the obvious double-encoding signature — never reaches the wire |

`utf16_escape` spells `/` as a **lookalike codepoint** rather than as `/` itself: a
stack that resolves `%uXXXX` at all tends to fold U+2215 and U+2044 onto the ASCII
character, while a filter that only knows `%XY` sees an unparseable sequence. The
codepoint is a stage *argument* rather than a second catalog entry because it is
the same hypothesis at a different codepoint — and because it rides in the stage's
name, a report cannot print two of them as though they were one.

`double_percent` is a double encoding with **no `%25` in it**. It keeps a literal
`%` and percent-encodes the *hex digits* instead: `%32` is `2` and `%66` is `f`, so
one decode of `%%32%66` is the text `%2f` and a second is `/`.

Both are `path -> escapes`, like `overlong_utf8` and `fullwidth`, so
`base64 > utf16_escape` was rejected by the stage-signature system on the day they
were written, with no new code in the parser. That is the strongest argument the
signature lattice has produced: the rule was written for stages that did not exist
yet, and it held.

**Both ship commented out** — in `src/seed.ts`'s starter config, and absent from
`pt-full.yml` entirely. So they contribute **zero** payloads to the numbers in this
report, and the 100% coverage of `percent-u` (2/2) and `nested-percent` (4/4) comes
from the pre-encoded primitives. What the stages buy, measured by enabling all
three entries against `target-core ∪ target-encoded`:

| | as shipped | with the three entries |
| --- | --- | --- |
| payloads | 99,111 | 102,145 (+3,034) |
| `percent-u` targets pt reaches | 41 | **57** |
| `nested-percent` targets pt reaches | 45 | **57** |
| reference coverage | 21,130 / 21,132 | 21,130 / 21,132 |

That is the right shape for the result. A pre-encoded primitive respells its own
separator and nothing else; the stages respell the separators **inside the target**
too, for any target in the file. They are width, not a closed gap — which is why
they are worth a line in the catalog and not a block of everyone's wordlist.

The two findings are independent, and the interaction is worth one sentence: 36 of
the passthrough's former 398 lines were in these two classes, 18 each, and all 36
turned out to be doubled junctions
(`..%u2215..%u2215..%u2215/etc/passwd`). The non-greedy strip decomposed every one
of them into a pre-encoded primitive plus a `//`-target **before** these stages
existed, which is why neither `raw.txt` contains a `%uXXXX` or `%%NN` line at all.

### What remains in the passthrough: 147 lines, three shapes

Replaying `decompose()` over the 147 lines: **all 147** are routed by the
*breaks-at-the-last-step* rule, and **none** by the round-trip self-check. The
check is still the guarantee that no slot file holds a guess, but it currently
catches nothing — the parse rules are doing the whole job.

| n | shape | step chain | last step | class |
| --- | --- | --- | --- | --- |
| 24 | A. last step drops the noise the others carry | `.././` | `../` | `plain` |
| 24 | A. | `..\.\` | `..\` | `plain` |
| 24 | A. | `..//.//` | `..//` | `plain` |
| 24 | A. | `..\\.\\` | `..\\` | `plain` |
| 7 | B. last step's separator run is a different token | `..%5c` | `../` | `partial-sep` |
| 6 | B. | `.././` | `..//` | `plain` |
| 6 | B. | `..\.\` | `..\/` | `plain` |
| 6 | B. | `..//.//` | `..///` | `plain` |
| 6 | B. | `..\\.\\` | `..\\/` | `plain` |
| 8 | C. head of period 2, escalating separator run | `../ \| ..//` | `..///` | `plain` |
| 8 | C. | `..\ \| ..\\` | `..\\\` | `plain` |
| 4 | C. head of period 2, alternating separator identity | `../ \| ..\` | `..\` | `plain` |

Rolled up: **96 shape A, 31 shape B, 20 shape C**, and by primary class **140
`plain`, 7 `partial-sep`** — the seven being the whole of the `..%5c` family. The
orthogonal features are `noise-dot` on 120 of them, `noise-slash` on 88 and
`backslash` on 79.

**Shape A (96) is the exact mirror image of what closure 1 fixed.** `reflowTail`
hands back separators the greedy tail *swallowed*; these need the chain allowed to
stop one step **early**, with the dropped noise moving into the target
(`../etc/passwd`). Four distinct step/tail pairs account for all 96:
`.././ → ../`, `..\.\ → ..\`, `..//.// → ..//`, `..\\.\\ → ..\\`.

**Shape B (31)** is four of the same pairs with a separator *gained* rather than
lost (`.././ → ..//`), plus the seven genuinely-inconsistent `..%5c` then `../`
lines, where a single-encoded separator and a literal one disagree. Those seven are
the canonical case for the passthrough existing at all.

**Shape C (20) should stay.** Each has a head that repeats with period 2 —
`../ | ..// | ../ | ..//`, or `../ | ..\` alternating — so reflowing the tail would
produce a chain of odd length with no proper period, i.e. a monolithic depth-1
primitive that reproduces exactly one string and nothing else. That is the
opposite of generative, and `raw_file` is the honest place for it.

So roughly **127 of 147 look recoverable** by a change of the same kind as closure
1, and the measured risk of that kind of change — 72 payloads changed shape, zero
coverage movement — is the argument for trying it rather than assuming it is safe.

### The passthrough over-counts, and the checker says by how much

```
raw_file entries                                    147
  whose (target, class) pairs the GENERATOR also makes  147  100.0%
  genuinely only reachable verbatim                   0
```

Every one of the 147 has all of its `(target, class)` pairs produced by the
generator as well, because `dot_noise` and `selective_first` reach shapes no
`traversal × repeat` does. The two numbers answer different questions and both are
worth having: by *pair*, the passthrough adds nothing, and by *exact payload* it
adds 147 strings no strategy emits.

---

## 10. The inverse: what pt adds

| class | pt | ref | verdict |
| --- | --- | --- | --- |
| `triple-url` | 57 | **0** | **NEW — no reference list contains this technique** |
| `semicolon` | 1,630 | 2 | +1,628 targets |
| `plain` | 1,434 | 283 | +1,151 |
| `absolute-no-traversal` | 15,823 | 14,587 | +1,236 |
| `noise-slash` | 1,010 | 13 | +997 |
| `backslash` | 6,136 | 5,145 | +991 |
| `partial-sep` | 783 | 5 | +778 |
| `noise-dot` | 723 | 5 | +718 |
| `trailing-ext` | 870 | 263 | +607 |
| `null-byte` | 891 | 324 | +567 |
| `trailing-dot-space` | 870 | 473 | +397 |
| `base64` | 100 | 5 | +95 |
| `overlong` / `fullwidth` | 57 / 57 | 3 / 3 | +54 each |
| `double-url` | 57 | 7 | +50 |
| `partial-dots` | 52 | 3 | +49 |
| `full-url` | 53 | 5 | +48 |
| `nested-percent` | 45 | 4 | +41 |
| `percent-u` | 41 | 2 | +39 |

`triple-url` is the only class pt produces that no reference list contains at all.
The rest is the generative model doing what a wordlist cannot: the corpus pairs
`overlong` with three targets because somebody typed three lines, while pt pairs it
with 57 because **a strategy is orthogonal to the target list and a wordlist line
is not**.

The larger addition is not in this table, and it is the other side of §6's thin
categories. The public corpus does not contain modern infrastructure targets at
all. Every one of these markers returns **zero** across the whole 34,664-line
reference corpus:

```
/.claude  .mcp.json  /.codex  /.cursor  github-copilot  .aider  /.ollama
huggingface/token  /.kube  serviceaccount  .tfstate  id_ed25519
docker-compose  /.dockerenv  chroma  index.faiss        -- 0 hits each
```

Loose substring searches do match a little — `cursor` 10 times and `docker` twice —
but every hit is unrelated: X11 cursor themes, PowerDNS `recursor.conf`, and two
Visual Studio `dockertools` installer logs. There is no Cursor editor directory and
no Docker configuration in the corpus.

`devops/target.txt` carries **138 curated entries in 14 headed sections** against
that absence — in-pod Kubernetes service-account tokens, kubeconfigs on
lightweight distros, Terraform state, cloud instance user-data, CI runner
credentials, cloud CLI credentials, Ed25519 keys, agent configs and transcripts,
and RAG vector stores. `macos/`, `windows/` and the four thin `language/` files
carry 105 more. None of it is in the coverage table, because the reference corpus
has nothing to compare it against — which is the point of carrying it.

---

## 11. Wordlist size

```
  strategy                                                                  payloads         new    unique
  --------------------------------------------------------------------------------------------------------
  raw_file (verbatim)                                                            147      (+147)       147
  plain | target=linux/target.txt, traversal=off                               8,473    (+8,473)     8,149
  plain | target=windows/target.txt, traversal=off                             5,961    (+5,961)     5,599
  plain | target=macos/target.txt, traversal=off                                  61       (+61)        49
  plain | target=devops/target.txt, traversal=off                                871      (+871)       735
  plain | target=language/target-php.txt, traversal=off                          419      (+419)       363
  plain | target=language/target-java.txt, traversal=off                          22       (+22)        22
  plain | target=language/target-dotnet.txt, traversal=off                        14       (+14)        10
  plain | target=language/target-python.txt, traversal=off                        19       (+19)        19
  plain | target=language/target-node.txt, traversal=off                          20       (+20)        19
  plain | target=language/target-ruby.txt, traversal=off                          12       (+12)        12
  plain | target=language/target-perl.txt, traversal=off                          41       (+41)        39
  plain | target=target-hot.txt                                                7,857    (+6,738)     4,918
  plain | target=target-hot.txt, traversal=traversal-min.txt, suffix=lang…    34,047   (+30,936)    30,936
  plain | traversal=windows/traversal.txt+linux/traversal.txt+language/tr…     7,254    (+7,110)     6,851
  plain | prefix=windows/prefix.txt+linux/prefix.txt+devops/prefix.txt        18,603   (+18,235)    18,206
  dot_noise | target=target-core.txt+target-encoded.txt                        1,197      (+983)       963
  double_slash | target=target-core.txt+target-encoded.txt                     1,197      (+952)       951
  backtrack | target=target-core.txt+target-encoded.txt                        1,197      (+988)       988
  matrix_param | target=target-core.txt+target-encoded.txt                     1,197      (+988)       988
  url_encode:1 | target=target-core.txt+target-encoded.txt                     1,197      (+797)       764
  url_encode:1 > hex_case_upper | target=target-core.txt+target-encoded.t…     1,197      (+798)       798
  url_encode:2 | target=target-core.txt+target-encoded.txt                     1,197      (+798)       798
  url_encode:3 | target=target-core.txt+target-encoded.txt                     1,197      (+798)       798
  overlong_utf8 | target=target-core.txt+target-encoded.txt                    1,197    (+1,011)       995
  overlong_utf8(+dots) | target=target-core.txt+target-encoded.txt             1,197    (+1,023)     1,023
  fullwidth | target=target-core.txt+target-encoded.txt                        1,197    (+1,040)     1,040
  path_case_upper | target=target-core.txt+target-encoded.txt                  1,197    (+1,036)     1,036
  url_encode:1(charset=".") | target=target-core.txt+target-encoded.txt        1,197      (+949)       949
  url_encode:1(charset="/\\") | target=target-core.txt+target-encoded.txt      1,197      (+750)       700
  selective_first | target=target-core.txt+target-encoded.txt                  1,197      (+966)       903
  selective_last | target=target-core.txt+target-encoded.txt                   1,197      (+954)       954
  selective_alternating | target=target-core.txt+target-encoded.txt            1,197      (+903)       903
  base64 | target=target-core.txt+target-encoded.txt                           1,197    (+1,014)       672
  base64 > url_encode:1(charset="+/=") | target=target-core.txt+target-en…     1,197      (+697)       697
  trailing_space | target=target-hot.txt, traversal=traversal-min.txt          2,619    (+2,578)     2,578
  padding:2048 | target=target-padding.txt, traversal=traversal-min.txt, …         9        (+9)         9
  total unique                                                                99,111
```

**99,111 payloads**, under `warn_above: 250000` and well under
`max_payloads: 500000`. No tuning was forced, but the shape of the config *is* the
tuning, and every choice in it was made on a measurement:

* **The eleven bare-path blocks are the split, made legible.** One `plain` line per
  category file, so `--dry-run` attributes payloads *per category* and the report
  says what each stack dimension is worth. They are also the lines a real config
  deletes: keeping only the folders recon found is a matter of removing rows from
  the top of this table.
* **One repeat rung, not four.** Root clamping makes extra rungs redundant (§4).
  `[3,6,10,16]` would have cost 4× for nothing.
* **Big files are never crossed with each other.** `linux/target.txt` (8,473) ×
  the 185 traversal primitives is 1.57M payloads **per strategy** before a prefix
  is involved; across the whole 15,913-line target dimension it is 2.94M, and with
  all 52 prefixes 153M. The measurement that licenses splitting them is §5's
  asymmetry: of 14,610 distinct resolved targets, 14,587 appear as a bare absolute
  path and only **16** are ever written respelled, while the nine respelling
  classes between them ask for 32 pairs. So each big file gets exactly one block,
  paired with small ones.
* **Rewrite strategies run against `target-core.txt ∪ target-encoded.txt`** — 133
  lines, 1,197 payloads each, across **19** blocks. `target-encoded.txt` is
  *derived*, not curated: it is the targets the corpus itself writes with a
  respelled separator, computed by `classesOf()`, stored in literal spelling so the
  strategy supplies the encoding rather than double-encoding it. Measured: pointing
  all 19 rewrite blocks at `target-hot.txt` instead takes the wordlist to
  **205,793 payloads**, +106,682 for the same pairs.
* **Long padding prefixes dropped.** 16 harvested prefixes over 48 bytes were
  `AAAA…/` and `./././…` length attacks. `padding:N` generates those from one
  integer, so carrying them as literal lines would multiply every payload's length
  for no new coverage.
* **`trailing_dot` is not in the list, on evidence.** Re-measured by adding it back
  against `target-hot.txt`:

  ```
  trailing_space | target=target-hot.txt, traversal=traversal-min.txt   2,619  (+2,578)  2,578
  trailing_dot   | target=target-hot.txt, traversal=traversal-min.txt   2,619      (+0)      0
  total unique                                                        99,111
  ```

  2,619 payloads for `(+0)` new and `0` unique, and the total does not move. The
  harvest found a literal `.` suffix in the reference lists — it is in
  `windows/suffix.txt` — block 3 already crosses it with every hot target, and an
  appended dot lands in exactly the same place. The technique is covered; the
  second route to it is not.

The `unique` column is the one that answers "can I delete this?", because it is
computed against the union of all the others and so does not depend on order. No
entry in the list reads 0 there.

Per-input attribution says the same thing one level down: **910 of the 17,181 input
lines are redundant**, meaning deleting any one of them changes the output by
exactly nothing. `--dry-run` itemises only the first 40 of those rows — 34 in
`devops/target.txt` and 6 in `target-encoded.txt`, each annotated with the earlier
strategy that already reaches the same bytes — and summarises the remaining 870 as
a count, so the per-file breakdown of the 910 is not something this report can
state.

What it can state is where the overlap comes from, because the derived sizing files
are drawn from the same harvest as the categorised ones:

```
target-hot.txt        873 lines,  873 also appear verbatim in a category target file
target-core.txt        39 lines,   32 also appear verbatim
target-encoded.txt     94 lines,   13 also appear verbatim
target-padding.txt      3 lines,    3 also appear verbatim
traversal-core.txt      8 lines,    7 also appear verbatim in a category traversal file
traversal-min.txt       2 lines,    2 also appear verbatim
```

Every line of `target-hot.txt` is a line of some category file, by construction.
That duplication is deliberate and it is the whole sizing strategy: the categorised
file emits the target bare, the derived file carries the same target into the
blocks that cross it with traversals and suffixes, and `plain`'s first-wins dedupe
means the overlap costs one payload, not two.

---

## 12. Test suite

```
$ bun test
bun test v1.3.14 (0d9b296a)

 353 pass
 0 fail
 1104 expect() calls
Ran 353 tests across 11 files. [16.96s]
```

`bun run typecheck` (`tsc --noEmit`) is clean. Re-running
`scripts/harvest-wordlists.ts` rewrites every file in `templates/` byte-identically
to what is already there, so the figures in this document and the files in
`templates/` cannot be out of step with each other.

---

## Historical note: figures this revision corrects

The previous revision was measured against the **pre-split flat layout**
(`templates/*-full.txt`). The split into
`templates/{linux,windows,macos,language,devops}/` renamed every harvested file and
moved most of the figures. The comparison is kept only where someone holding the
old numbers would otherwise be misled.

### File-name mapping

| before | now |
| --- | --- |
| `target-full.txt` | `{linux,windows,macos,devops}/target.txt` + `language/target-{php,java,dotnet,python,node,ruby,perl}.txt` |
| `traversal-full.txt` | `{linux,windows}/traversal.txt` + `language/traversal-java.txt` |
| `prefix-full.txt` | `{windows,linux,devops}/prefix.txt` |
| `suffix-full.txt` | `{language,windows}/suffix.txt` |
| `raw-full.txt` | `{windows,linux}/raw.txt` |

The six sizing files (`target-hot`, `target-encoded`, `target-core`,
`target-padding`, `traversal-core`, `traversal-min`) and `empty.txt` kept their
names at the `templates/` root.

### Figures

| claim in the previous revision | measured now |
| --- | --- |
| `pt-full.yml` 95,484 payloads | **99,111**. The +3,627 reconciles exactly: the prefix block went 15,093 → 18,603 (+3,510) on 10 extra curated document roots, and the bare-path blocks carry 117 extra curated targets. Nothing else moved. |
| target dimension 15,796 | **15,913** (+117 curated for `macos/` and `language/`) |
| prefix dimension 42 | **52** (+10 curated document roots) |
| `pt-full.yml` reference pairs 29,081 | **30,689** |
| `bun test` 310 pass across 10 files | **353 pass, 0 fail, across 11 files** |
| closing the two gaps costs **+180,120 (2.9×)** / **+59,376 (62%)** | **+222,240 (3.24×)** for the one-word change, **+73,416 (74%)** for a dedicated block |
| configuration B 91,966 payloads; C 80,602 | **B 95,593**; **C1 78,887** (literal-only primitives) and **C2 95,164** (only the 11 `partial-dots` primitives removed) — both still **0/3** |
| configuration C with the passthrough also removed: 80,455 | **78,740**, still `partial-sep` 5/5 |
| enabling `utf16_escape` ×2 + `double_percent`: 98,518 (+3,034) | **102,145 (+3,034)** — the delta is identical, the base is not |
| pointing **21** rewrite blocks at `target-hot.txt`: 202,166 (+106,682) | **19** blocks, **205,793 (+106,682)** — the delta is identical; there were never 21 |
| 126 curated entries in 13 headed sections | **255 curated lines in 25 headed sections** — 243 targets, 12 prefixes |
| `traversal-full.txt`'s 185 primitives, 11 of them `partial-dots` | 185 and 11 — unchanged, now split 93 / 91 / 1 across three files |
| `raw-full.txt` 147, shapes 96 / 31 / 20 | unchanged — now `windows/raw.txt` 95 + `linux/raw.txt` 52 |
| `target-encoded.txt` 94, 28 NUL-bearing lines | unchanged, and it is still the **only** file in `templates/` that grep treats as binary |

### Three claims that were wrong, not merely stale

1. **"14,587 of 14,610 distinct targets appear as a bare absolute path; 14,032
   appear only that way, and 578 ask for more."** The first figure reproduces. The
   second two do not, under any definition tried. Measured: **9,117** targets appear
   only as a bare absolute path with no other class at all, so **5,493** ask for
   something more; **14,317** have no primary class other than
   `absolute-no-traversal`; **293** appear with some other primary class; and only
   **16** are ever written in a respelling class. The numbers now in §5 state which
   definition each one uses, because the ambiguity is what produced the wrong pair.
   The same overstatement is still in `pt-full.yml`'s comments, which say 14,608
   distinct targets and 23 encoded-class pairs.
2. **"Zero hits for `claude`, `codex`, `cursor`, `copilot`, `aider`, `ollama`,
   `huggingface`, `openai`, `kube`, `docker`, `serviceaccount`, `terraform` or
   `ed25519` across the entire 34,674-line corpus."** False as written: `cursor`
   matches 10 lines and `docker` 2. Every match is unrelated — X11 cursor themes,
   PowerDNS `recursor.conf`, Visual Studio `dockertools` logs — so the substance
   holds, but the test has to be the path markers, not loose substrings. §10 now
   lists 16 precise markers and all 16 return zero.
3. **"3,842 lines of `Windows-Paths.txt` contain a space and almost all are
   `Program Files` or `Documents and Settings`."** The count is **3,844**, and
   those two patterns are 2,788 of them — 73%, not "almost all". The other 1,056
   are equally legitimate (`C:\ProgramData\Microsoft\Device Stage\…`,
   `C:\MySQL\MySQL Server 5.0\data\…`), which strengthens rather than weakens the
   point the sentence was making: the discard rule had to be narrow, and 14 lines
   out of 3,844 is its entire yield.

Earlier corrections, from the revision before the split, are kept because they are
still the reason those figures read as they do: the passthrough was 708 then 398
before reaching 147; routed-to-raw was 805 then 459 before 202; the round-trip
self-check was once credited with catching 16 entries, and catches **0**; 19 long
prefixes were once reported dropped, and it is **16**; the exotic encodings were
once called "50 primitives' worth", and they are **34** (18 `%uXXXX`, 16 `%%NN`).
