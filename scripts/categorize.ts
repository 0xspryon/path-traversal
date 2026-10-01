/**
 * Classify one corpus entry into the five template categories.
 *
 *   windows | macos | linux | language | devops
 *
 * `scripts/harvest-wordlists.ts` calls this to write `templates/<category>/`
 * instead of one flat `templates/*-full.txt`, because the tool's premise is that
 * you recon the target's stack FIRST and then assemble a wordlist that matches
 * it. A flat corpus cannot express that choice; a folder per stack dimension
 * can.
 *
 * Two rules decide every call, in this order.
 *
 * 1. **An OS-rooted path beats a stack marker.** `C:\xampp\php\php.ini` names
 *    PHP, but the path only resolves on Windows, so it is a Windows target, and
 *    `/Volumes/Macintosh_HD1/usr/local/php/lib/php.ini` is macOS for the same
 *    reason. Recon establishes the OS before the runtime, and the OS is the half
 *    that makes the path syntactically impossible anywhere else.
 *
 * 2. **Otherwise the most specific stack component wins**, where specific means
 *    runtime before infrastructure before distro. `/etc/php/8.3/cli/php.ini` is
 *    PHP, `/etc/nginx/nginx.conf` is nginx, `/etc/passwd` is just Linux. A path
 *    should live in the folder you reach for after fingerprinting that one
 *    thing.
 *
 * So: windows -> macos -> language -> devops -> linux. First match wins and no
 * entry is ever written twice, which is what keeps the five folders a partition
 * rather than five overlapping views.
 */

export type Category = "windows" | "macos" | "linux" | "language" | "devops"

/** The per-language files `language/` is split into, in match order. */
export type Language = "php" | "java" | "dotnet" | "python" | "node" | "ruby" | "perl"

export const LANGUAGES: ReadonlyArray<Language> = [
  "php",
  "java",
  "dotnet",
  "python",
  "node",
  "ruby",
  "perl"
]

/**
 * Normalise for matching only: lowercase, every separator spelling folded to
 * `/`, and the percent/hex spellings of `/` and `\` decoded once. The value
 * WRITTEN to a template file is always the original line; this is a lens, never
 * an edit.
 */
const fold = (value: string): string =>
  value
    .toLowerCase()
    .replace(/%25/g, "%")
    .replace(/%2f|%5c|%c0%af|%c1%9c|%ef%bc%8f|%ef%bc%bc|0x2f|0x5c|%u2215|%u2216/g, "/")
    .replace(/\\/g, "/")

/** A DOS drive letter, anywhere a path component can start: `C:`, `c:/`, `D:\`. */
const DRIVE = /(^|\/)[a-z]:(\/|$)/

/** `\\host\share`, `\\?\`, `\\.\`, `//?/`, `//./` -- Win32 device and UNC preludes. */
const UNC = /^\/\/([?.]\/|[a-z0-9_.:$-]+\/[a-z0-9_.$-]+)/

/** A `\`-class separator in any spelling. */
const BACKSLASH = /\\|%5c|%255c|%25%5c|%c1%9c|%ef%bc%bc|0x5c|%u2216|%%35%63/i

/**
 * A POSIX-absolute path under a root every Linux and BSD system has. Used only
 * to stop the SYNTACTIC Windows tests (a stray `\` or a leading `//`) from
 * claiming `.\\./.\\./..//etc/passwd` and `//etc/passwd`, both of which are in
 * the corpus and both of which are Linux targets wearing Win32 noise. An
 * explicit Windows marker such as `system32` still wins over this.
 */
const POSIX_ROOTED =
  /\/(etc|var|proc|usr|home|root|opt|tmp|dev|sys|run|boot|srv|mnt|media|bin|sbin|lib|lib64|selinux)\//

const WINDOWS_MARKERS = [
  "windows/",
  "winnt/",
  "/windows",
  "/winnt",
  "boot.ini",
  "win.ini",
  "system32",
  "syswow64",
  "sysnative",
  "inetpub",
  "iisadmin",
  "iis express",
  "metabase.xml",
  "applicationhost.config",
  "program files",
  "programdata",
  "windowsapps",
  "windowspowershell",
  "documents and settings",
  "ntuser.dat",
  "ntds.dit",
  "repair/sam",
  "config/sam",
  "config/system",
  "config/security",
  "config/software",
  "config/regback",
  "autoexec.bat",
  "config.sys",
  "sysprep",
  "unattend",
  "pagefile.sys",
  "hiberfil.sys",
  "/perflogs",
  "recycler",
  "$recycle.bin",
  "desktop.ini",
  "microsoft.net/framework",
  "appdata/local"
] as const

/**
 * macOS roots, anchored. Unanchored they claim `/etc/samba/private/smbpasswd`
 * and the whole `/etc/selinux/.../users/` tree, which are Linux.
 */
const MACOS_ROOTS =
  /^\/+(volumes|library|system|applications|private|users|cores|\.vol)\/|^\/+(opt\/homebrew|usr\/local\/cellar)/

const MACOS_MARKERS = [
  ".ds_store",
  "keychain",
  "launchdaemons",
  "launchagents",
  "com.apple.",
  "/etc/kcpassword",
  "/var/db/dslocal",
  "/var/vm/sleepimage",
  "/var/db/.applesetupdone",
  "/etc/auto_master",
  "/etc/synthetic.conf",
  "osxhttpd",
  "/webobjects"
] as const

/**
 * Per-language markers. `path` entries are plain substrings of the folded path;
 * `ext` entries are matched as a real extension of the BASENAME, so `.pl` does
 * not fire on `.placeholder`, `.js` does not fire on `config.json`, and `.war`
 * does not fire on `mail.warn`. All three were real false positives.
 */
interface LanguageRule {
  readonly language: Language
  readonly path: ReadonlyArray<string>
  readonly ext: ReadonlyArray<string>
}

const LANGUAGE_RULES: ReadonlyArray<LanguageRule> = [
  {
    language: "php",
    path: [
      "php.ini",
      "php3.ini",
      "php4.ini",
      "php5.ini",
      "/php.d",
      "/php/",
      "/php3",
      "/php4",
      "/php5",
      "/php7",
      "/php8",
      "php-fpm",
      "php_errors",
      "php_error",
      "php:",
      "phar:",
      "zip:",
      "expect:",
      "data://",
      "glob:",
      ".htaccess",
      ".htpasswd",
      "composer.json",
      "composer.lock",
      "/vendor/autoload",
      "wp-config",
      "configuration.php",
      "localsettings.php",
      "config.inc",
      "/pear/",
      "pear.conf",
      "/phpmyadmin",
      "phpldapadmin",
      "/squirrelmail",
      "/roundcube",
      "/mediawiki",
      "/drupal",
      "/joomla",
      "/wordpress",
      "/typo3",
      ".php_history"
    ],
    ext: ["php", "php3", "php4", "php5", "php7", "phtml", "phps", "inc"]
  },
  {
    language: "java",
    path: [
      "web-inf",
      "meta-inf",
      "web.xml",
      "jndi.properties",
      "hibernate.cfg",
      "applicationcontext.xml",
      "struts-config.xml",
      "faces-config.xml",
      "/classes/",
      "log4j",
      "logback.xml",
      "application.properties",
      "/jdk",
      "/jre",
      "java.security",
      "java.policy",
      "/cacerts"
    ],
    ext: ["jsp", "jspx", "jsf", "jar", "war", "ear", "keystore", "jks"]
  },
  {
    language: "dotnet",
    path: [
      "web.config",
      "machine.config",
      "global.asa",
      "appsettings.json",
      "/app_data",
      "/bin/debug",
      "/bin/release",
      "/mono/"
    ],
    ext: ["asp", "aspx", "ashx", "asmx", "asax", "cs", "vb"]
  },
  {
    language: "python",
    path: [
      "/python",
      "site-packages",
      "dist-packages",
      "settings.py",
      "manage.py",
      "wsgi.py",
      "asgi.py",
      "requirements.txt",
      "pyproject.toml",
      "pipfile",
      "setup.py",
      ".pythonstartup",
      "/pip.conf",
      ".pypirc",
      "uwsgi.ini",
      "gunicorn",
      "/virtualenv",
      "/venv/"
    ],
    ext: ["pyc", "pyo"]
  },
  {
    language: "node",
    path: [
      "package.json",
      "package-lock.json",
      "node_modules",
      ".npmrc",
      ".nvmrc",
      "yarn.lock",
      "pnpm-lock",
      "ecosystem.config",
      "/node/",
      "/nodejs",
      "next.config",
      "nuxt.config",
      "tsconfig.json",
      "/pm2"
    ],
    ext: ["js", "mjs", "cjs", "ts"]
  },
  {
    language: "ruby",
    path: [
      "gemfile",
      ".gemrc",
      "/gems/",
      "database.yml",
      "secrets.yml",
      "/.bundle",
      "/rails",
      "unicorn.rb",
      "puma.rb",
      "/ruby"
    ],
    ext: ["rb", "erb", "gemspec"]
  },
  {
    language: "perl",
    path: ["/perl/", "/perl5", "cpan/config", "/.cpan"],
    ext: ["pl", "pm", "cgi", "plx"]
  }
]

/**
 * The 2026-era AI-agent tooling targets, kept together in `devops/` as their own
 * headed section: an `.mcp.json` or a `~/.codex/auth.json` identifies the
 * build-and-deploy toolchain exactly the way a `docker-compose.yml` does, and
 * what it leaks is credentials for everything else.
 */
export const AGENT_SECTION =
  "AI agent tooling (2025-2026): configs, transcripts and RAG stores"

const AGENT_MARKERS = [
  ".mcp.json",
  ".claude.json",
  "/.claude",
  "claude.md",
  "claude_desktop_config",
  "/.codex",
  "agents.md",
  "gemini.md",
  "github-copilot",
  "/.cursor",
  "/.continue",
  ".aider",
  "huggingface/token",
  "/.ollama",
  "chroma.sqlite3",
  "/chroma/",
  "index.faiss",
  "index.pkl",
  "docstore.json"
] as const

const DEVOPS_MARKERS = [
  // web servers and reverse proxies
  "nginx",
  "apache",
  "httpd",
  "lighttpd",
  "caddy",
  "haproxy",
  "varnish",
  "squid",
  "traefik",
  "/envoy",
  "cherokee",
  "thttpd",
  "boa.conf",
  "/access.log",
  "/access_log",
  "/error.log",
  "/error_log",
  "access-log",
  "/logs/",
  // application servers
  "tomcat",
  "/jetty",
  "jboss",
  "wildfly",
  "weblogic",
  "websphere",
  "glassfish",
  "catalina",
  "server.xml",
  "/resin",
  // containers and orchestration
  "kubernetes",
  "kubelet",
  "kubeconfig",
  "/.kube",
  "serviceaccount",
  "/k3s",
  "rke2",
  "rancher",
  "docker",
  "containerd",
  "podman",
  "compose.yml",
  "compose.yaml",
  "/crio",
  "/proc/self/cgroup",
  "/proc/1/cgroup",
  "mountinfo",
  // infrastructure as code and configuration management
  "terraform",
  "ansible",
  "/puppet",
  "/chef",
  "/salt",
  "vagrantfile",
  "pulumi",
  // CI / CD
  "jenkins",
  "gitlab",
  "_github_workflow",
  "/.github/",
  "circleci",
  ".travis.yml",
  "/drone",
  "buildkite",
  "teamcity",
  "bamboo",
  // secrets, identity and cloud
  "vault",
  "/consul",
  "/nomad",
  "/etcd",
  "/.aws",
  "/.azure",
  "gcloud",
  "azure-identity",
  "eks.amazonaws.com",
  "cloud.cfg",
  "/var/lib/cloud",
  "user-data",
  "/run/secrets",
  // data stores -- part of the serving stack, and each one names itself
  "mysql",
  "my.cnf",
  "mariadb",
  "postgres",
  "pg_hba",
  "pgpass",
  "/redis",
  "mongod",
  "/mongo",
  "/couchdb",
  "/cassandra",
  "/elasticsearch",
  "/rabbitmq",
  "/kafka",
  "/zookeeper",
  "/memcached",
  "/influxdb",
  "/clickhouse",
  "/oracle",
  "mssql",
  "/db2",
  // service supervision
  "systemd",
  "/supervisor",
  "/etc/rc.conf",
  "monit"
] as const

const hasAny = (folded: string, markers: ReadonlyArray<string>): boolean =>
  markers.some((marker) => folded.includes(marker))

/** Does the basename of `folded` end in one of these extensions? */
const hasExt = (folded: string, extensions: ReadonlyArray<string>): boolean => {
  const base = folded.slice(folded.lastIndexOf("/") + 1)
  return extensions.some((ext) => {
    const at = base.indexOf(`.${ext}`)
    if (at < 0) return false
    // Accept `.php`, `.php.bak`, `.php%00.png`, `.php?x` -- reject `.phpx`.
    const after = base.slice(at + ext.length + 1)
    return after.length === 0 || /^[^a-z0-9]/.test(after)
  })
}

export interface Classification {
  readonly category: Category
  /** Set only when `category` is `"language"`. */
  readonly language?: Language
  /** Set when the entry belongs in its own headed section inside the file. */
  readonly section?: string
}

/** Classify a target path into a folder, and for `language/` into a file. */
export const classifyTarget = (value: string): Classification => {
  const folded = fold(value)
  const lower = value.toLowerCase()

  // 1. OS-rooted: the path cannot resolve anywhere else.
  if (hasAny(folded, WINDOWS_MARKERS) || DRIVE.test(folded)) {
    return { category: "windows" }
  }
  if (
    (UNC.test(folded) || BACKSLASH.test(lower)) &&
    !POSIX_ROOTED.test(folded)
  ) {
    return { category: "windows" }
  }
  if (MACOS_ROOTS.test(folded) || hasAny(folded, MACOS_MARKERS)) {
    return { category: "macos" }
  }

  // 2. Stack components: runtime, then infrastructure, then plain distro.
  for (const rule of LANGUAGE_RULES) {
    if (hasAny(folded, rule.path) || hasExt(folded, rule.ext)) {
      return { category: "language", language: rule.language }
    }
  }
  if (hasAny(folded, AGENT_MARKERS)) {
    return { category: "devops", section: AGENT_SECTION }
  }
  if (hasAny(folded, DEVOPS_MARKERS)) return { category: "devops" }

  return { category: "linux" }
}

/**
 * Separator identity of a traversal primitive or of a prefix. A `\`-class
 * separator in any spelling means the payload is aimed at Win32 path parsing;
 * `/`-class is POSIX. For these two slots that is the only dimension the entries
 * differ in, so it is the only split they get.
 */
export const separatorFamily = (value: string): "backslash" | "slash" | "neither" => {
  if (BACKSLASH.test(value)) return "backslash"
  if (/\/|%2f|%252f|%25%2f|%c0%af|%ef%bc%8f|0x2f|%u2215|%%32%66/i.test(value)) {
    return "slash"
  }
  return "neither"
}
