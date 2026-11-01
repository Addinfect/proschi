import { describe, expect, it } from 'vitest';
import landingHtml from '../../index.html?raw';
import { examples } from './examples';
import { format, formattedOffset } from './format';
import { parse } from './parser';

/** The parse result without source positions, which formatting is allowed to move. */
function meaning(source: string): unknown {
  const { diagram, diagnostics } = parse(source);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'loc' && key !== 'line' && key !== 'col' && key !== 'length')
          .map(([key, v]) => [key, strip(v)]),
      );
    }
    // Multi-line payloads are re-indented as a whole: compare them line by line, trimmed.
    if (typeof value === 'string' && value.includes('\n')) return value.split('\n').map((l) => l.trim()).join('\n');
    return value;
  };
  const messages = diagnostics.map((d) => `${d.severity}: ${d.message.replace(/line \d+/g, 'line N')}`).sort();
  return { diagram: strip(diagram), messages };
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The hero source and every highlighted snippet on the landing page (see landing.test.ts). */
const landingSnippets = [
  ...landingHtml.matchAll(/<pre[^>]*(?:id="hero-source"|data-proschi)[^>]*><code>([\s\S]*?)<\/code><\/pre>/g),
].map((m) => decodeEntities(m[1]));

const messy: [string, string][] = [
  [
    'everything at once',
    `\r\n\r\ntitle    "Shop"   \r\n\r\n\r\n   group   vpc "VPC"   [Network Boundary]{\r\n\r\napi "API" [REST API]   @team-a\r\n   db  [PostgreSQL]  "Main database" pos 10 , -20\r\n\r\n}\r\napi->db:SQL   # reads and writes\r\n\r\n\r\nusecase "U"{\r\n\r\napi -> db : POST /orders/{id} json {\r\n      "a": 1,\r\n         "b": [1,\r\n   2]\r\n    }   \r\n      db-->api:200\r\n} \r\n\r\n\r\n`,
  ],
  [
    'nested alts and par',
    `usecase "Checkout" {\na -> b : GET /x\nalt "One" {\npar {\nb -> c : one\nb ->> d : two\n}\nb --> a : 200\n}   alt  "Two" when "stock is low"{\nb --> a : 409\n}\n}\n`,
  ],
  [
    'invalid lines',
    `   a "unterminated\n%%% nonsense\n  b [Missing bracket\n}\n}\nfoo ->\nfoo -> bar baz : x\ngroup {\n  x\n`,
  ],
  [
    'comments everywhere',
    `# header\n  title "T"   # the title\napi [REST API] # first\ndatabase [Redis]   # second, longer line\n\n  # indented comment\nusecase "U" { # opens\n  # inside\napi -> database : GET /a # c1\napi -> database : x#not-a-comment\n}\n`,
  ],
  ['imports and tabs', `\timport   "shared/base.proschi"\nimport "other.proschi"\n\t\tapi\t"API"\t[REST API]\n`],
  ['unclosed payload', `usecase "U" {\n  a -> b : POST /x {\n      "open": [1, 2\n  b --> a : 200\n}\n`],
  ['unicode', `café "Café ☕" [REST API] @ü\nx "X" [Redis] @a\ncafé -> x : ünïcode\n`],
  [
    'HLD sections',
    `title "S"   "Summary"\napi [REST API]   x3\ndb [PostgreSQL] x2\nusecase "U" {\napi -> db : x\n}\n\n\ntraffic{\n"U"   100k   rps   mix "U" 90%,"Other"   10 %\n   "V" 2 rpm\n}\nrequirements {\np99 "U"<50ms\n  survive any node failure\nsurvive failure of [Redis]\n  cost<=3000 usd/month # budget\n\n\n}\ncapacity {\ndb 20k rps latency 4ms\napi durable\n  ghost\n}\nentity Url in db "d" {\ncode string key\ncreatedAt time index optional\n}\ndecision "D" {\n because "b"\nrejected "x"   "y"\n}\ndecision "E" because "f"\ntest "T" {\n"U" calls any database before db\nno path from api to   [Redis]\napi has replicas>=2\nbad line here\n}\n`,
  ],
  ['misplaced sections', `group g {\ntraffic {\n"U" 1 rps\n}\nx [Redis]\n}\nusecase "U" {\ntest "T" {\nno path from a to b\n}\na -> b\n}\n`],
  ['keywords as ids', `traffic [REST API]\ntest "Runner" x2\ndecision "Engine" [REST API]\ntraffic -> test\n`],
];

/** Every `.proschi` file in the repository: practice problems, fixtures, docs images, the GitHub action's tests. */
const files = Object.entries(
  import.meta.glob(['../**/*.proschi', '../../../docs/**/*.proschi', '../../../tooling/test/**/*.proschi', '../../../action/test/**/*.proschi'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>,
);

/** Every ```proschi fence of the docs and the blog. */
const fences = Object.entries(
  import.meta.glob(['../../../docs/*.md', '../../../blog/*.md'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
).flatMap(([path, md]) => [...md.matchAll(/^```proschi[^\n]*\n([\s\S]*?)^```/gm)].map((m, i): [string, string] => [`${path} fence ${i + 1}`, m[1]]));

const corpus: [string, string][] = [
  ...examples.map((e): [string, string] => [`example ${e.id}`, e.source]),
  ...landingSnippets.map((s, i): [string, string] => [`landing snippet ${i + 1}`, s]),
  ...files,
  ...fences,
  ...messy,
];

describe('format', () => {
  it('finds the landing page snippets', () => {
    expect(landingSnippets.length).toBeGreaterThan(1);
  });

  it('finds the .proschi files and docs fences, systems among them', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(fences.length).toBeGreaterThan(30);
    expect([...files, ...fences].filter(([, s]) => /^\s*system\s/m.test(s)).length).toBeGreaterThan(5);
  });

  it.each(corpus)('%s: is idempotent', (_name, source) => {
    const once = format(source);
    expect(format(once)).toBe(once);
  });

  it.each(corpus)('%s: keeps the meaning', (_name, source) => {
    expect(meaning(format(source))).toEqual(meaning(source));
  });

  it.each(corpus)('%s: leaves no trailing whitespace, runs of blank lines or tabs in indentation', (_name, source) => {
    const out = format(source);
    expect(out.endsWith('\n') && !out.endsWith('\n\n')).toBe(true);
    expect(out).not.toMatch(/[ \t]$/m);
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).not.toMatch(/^\t/m);
    expect(out).not.toContain('\r');
  });

  it('formats an empty document as empty', () => {
    expect(format('')).toBe('');
    expect(format('\n\n  \n')).toBe('');
  });

  it('indents two spaces per block and keeps `} alt` on one line', () => {
    expect(format('usecase "U" {\na -> b : x\nalt "A" {\npar {\nb -> c : y\n}\n}   alt "B"   {\nb --> a : 500\n}\n}')).toBe(
      'usecase "U" {\n  a -> b : x\n  alt "A" {\n    par {\n      b -> c : y\n    }\n  } alt "B" {\n    b --> a : 500\n  }\n}\n',
    );
  });

  it('handles `alt … when` and imports by their shape', () => {
    expect(format('import    "a.proschi"\nusecase "U" {\n  alt "A"   when "cold cache" {\n  a -> b : x\n}   alt "B" when "warm"{\n}\n}\n')).toBe(
      'import "a.proschi"\nusecase "U" {\n  alt "A" when "cold cache" {\n    a -> b : x\n  } alt "B" when "warm" {\n  }\n}\n',
    );
  });

  it('aligns node declarations in columns', () => {
    expect(format('gateway "API Gateway" [AWS API Gateway] @Platform\norders "Orders" [REST API] @Orders "Handles orders"\ndb [PostgreSQL]\n')).toBe(
      [
        'gateway "API Gateway" [AWS API Gateway] @Platform',
        'orders  "Orders"      [REST API]        @Orders   "Handles orders"',
        'db                    [PostgreSQL]',
        '',
      ].join('\n'),
    );
  });

  it('aligns connections with right-aligned arrows and aligned labels', () => {
    expect(format('user->api:HTTPS\napi -> database\ndb-->api : 1 row\napi -x user\n')).toBe(
      ['user -> api : HTTPS', 'api  -> database', 'db  --> api : 1 row', 'api  -x user', ''].join('\n'),
    );
  });

  it('ends a run at a blank line, a comment line, a different kind of line or a depth change', () => {
    const out = format('a -> bbbbbb : x\n\nccc -> d : y\n# note\neeeee -> f : z\ng [Redis]\nhh -> i : w\ngroup g2 {\njjjj -> k : v\n}\n');
    expect(out).toBe(
      [
        'a -> bbbbbb : x',
        '',
        'ccc -> d : y',
        '# note',
        'eeeee -> f : z',
        'g [Redis]',
        'hh -> i : w',
        'group g2 {',
        '  jjjj -> k : v',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('removes blank lines after { and before }, and collapses the rest', () => {
    expect(format('\n\ngroup g {\n\n\n  a [Redis]\n\n\n  b [Redis]\n\n}\n\n\n\nc [Redis]\n\n\n')).toBe('group g {\n  a [Redis]\n\n  b [Redis]\n}\n\nc [Redis]\n');
  });

  it('keeps comments verbatim, one space after the code or aligned within a run', () => {
    expect(format('title "T"    #   spaced   comment  \napi [REST API]\n')).toBe('title "T" #   spaced   comment\napi [REST API]\n');
    expect(format('a -> b : x   # one\nccc -> d : longer label # two\n')).toBe('a   -> b : x            # one\nccc -> d : longer label # two\n');
    expect(format('a -> b : x   # only one\nccc -> d : longer label\n')).toBe('a   -> b : x # only one\nccc -> d : longer label\n');
    expect(format('a -> b : {"tag": "#1"} #c\na -> b : x#y\n')).toBe('a -> b : {"tag": "#1"} #c\na -> b : x#y\n');
  });

  it('keeps labels verbatim apart from the spacing around the colon', () => {
    expect(format('a->b:   GET /orders/{id}   with   spaces  \n')).toBe('a -> b : GET /orders/{id}   with   spaces\n');
    expect(format('a -> b :\n')).toBe('a -> b :\n');
  });

  it('re-indents multi-line payloads with their step, keeping their inner layout', () => {
    const source = 'usecase "U" {\n      a -> b : POST /x json {\n        "a": [\n            1\n        ]\n      }\n  b --> a : 200\n}\n';
    expect(format(source)).toBe('usecase "U" {\n  a -> b : POST /x json {\n    "a": [\n        1\n    ]\n  }\n  b --> a : 200\n}\n');
  });

  it('treats a balanced {param} in a path as label text, as the parser does', () => {
    const source = 'usecase "U" {\na -> b : GET /orders/{id}\nb --> a : 200\n}\n';
    expect(format(source)).toBe('usecase "U" {\n  a  -> b : GET /orders/{id}\n  b --> a : 200\n}\n');
  });

  it('keeps blank lines and comments inside a payload', () => {
    expect(format('a -> b : {\n\n\n  # not a comment\n}\n')).toBe('a -> b : {\n\n\n  # not a comment\n}\n');
  });

  it('keeps lines the lexer rejects verbatim, only re-indented', () => {
    expect(format('group g {\n      a   "open    string\n  b   %%   c\n}\n')).toBe('group g {\n  a   "open    string\n  b   %%   c\n}\n');
  });

  it('normalises spacing inside other statements', () => {
    expect(format('group   g   "G"  [Security Zone]   pos  10 ,  -20  {\n}\n')).toBe('group g "G" [Security Zone] pos 10,-20 {\n}\n');
    expect(format('a [Redis] pos 1, 2  @t\n')).toBe('a [Redis] pos 1,2 @t\n');
  });

  it('maps a cursor position to the same place in the formatted text', () => {
    const before = '\n\n  api->db  :  SQL\n';
    const after = format(before);
    expect(after).toBe('api -> db : SQL\n');
    expect(formattedOffset(before, after, 0)).toBe(0);
    expect(formattedOffset(before, after, before.indexOf('api'))).toBe(0);
    expect(formattedOffset(before, after, before.length)).toBe(after.length - 1);
    expect(formattedOffset(before, after, before.indexOf('db'))).toBe(after.indexOf('db'));
    expect(formattedOffset(before, after, before.indexOf('SQL') + 1)).toBe(after.indexOf('SQL') + 1);
  });

  it('turns CRLF line endings into LF', () => {
    expect(format('title "T"\r\na [Redis]\r\n')).toBe('title "T"\na [Redis]\n');
  });

  it('aligns traffic, capacity and entity fields in columns', () => {
    expect(format('traffic {\n"Redirect" 100k rps mix "Hit" 90%, "Miss" 10%\n"Shorten"  1k rps\n"Delete" 10 rps mix "Gone" 100%\n}\n')).toBe(
      ['traffic {', '  "Redirect" 100k rps mix "Hit" 90%, "Miss" 10%', '  "Shorten"  1k rps', '  "Delete"   10 rps   mix "Gone" 100%', '}', ''].join('\n'),
    );
    expect(format('capacity {\ndb 20k rps latency 4ms\ncache   150k rps\n}\n')).toBe('capacity {\n  db    20k rps latency 4ms\n  cache 150k rps\n}\n');
    expect(format('entity Url in db {\ncode string key\ntarget string\ncreatedAt time index\n}\n')).toBe(
      'entity Url in db {\n  code      string key\n  target    string\n  createdAt time   index\n}\n',
    );
  });

  it('normalises spacing in quantities, operators and mixes', () => {
    expect(format('traffic {\n  "U" 100k   rps mix "A" 90 %,"B"   10%\n}\n')).toBe('traffic {\n  "U" 100k rps mix "A" 90 %, "B" 10%\n}\n');
    expect(format('requirements {\n  p99 "U"<50ms\n  cost<=3000   usd/month\n  availability>=99.9%\n}\n')).toBe(
      'requirements {\n  p99 "U" < 50ms\n  cost <= 3000 usd/month\n  availability >= 99.9%\n}\n',
    );
  });

  it('never reads section lines as nodes or connections', () => {
    expect(format('requirements {\n  survive any node failure\n  durable "Shorten"\n}\ndecision "D" {\n  because "x"\n  rejected "long option" "r"\n}\n')).toBe(
      'requirements {\n  survive any node failure\n  durable "Shorten"\n}\ndecision "D" {\n  because "x"\n  rejected "long option" "r"\n}\n',
    );
    // A one-line decision next to node declarations is not aligned with them.
    expect(format('api "API" [REST API]\ndecision "Use REST" because "simple"\n')).toBe('api "API" [REST API]\ndecision "Use REST" because "simple"\n');
  });

  it('indents section blocks like other blocks', () => {
    expect(format('test "T" {\n"U" calls db\n    no path from a to b\n}\n')).toBe('test "T" {\n  "U" calls db\n  no path from a to b\n}\n');
  });

  it('moves the rest of a node line into an empty team column', () => {
    const src = 'api  "API"   [REST API]    @backend\nnote "Note" [Sticky Note] "Read me first"\n';
    expect(format(src)).toBe('api  "API"  [REST API]    @backend\nnote "Note" [Sticky Note] "Read me first"\n');
  });

  describe('systems', () => {
    it('keeps a dotted reference to an exposed entry tight', () => {
      const src = 'title "Org"\nweb "Web" [React]\nsystem orders "Orders" @orders {\n  from "cloud:orders:latest"\n  expose api "API" -> "Place order"\n  capacity { rps 500 }\n}\nweb -> orders.api\n';
      expect(format(src)).toBe(src);
      expect(format('web->orders.api\n')).toBe('web -> orders.api\n');
    });

    it('keeps dotted references tight with every arrow, label and tag', () => {
      const src = [
        'system orders {',
        '  expose api -> "Place order"',
        '  expose admin -> "Refund"',
        '}',
        'web->orders.api:HTTPS',
        'orders.admin-->web : 200',
        'web ->> orders.api',
        'web -x orders.admin : drops',
        'web -> orders.api .planned : later',
        'a.b -> orders.api',
        '',
      ].join('\n');
      expect(format(src)).toBe(
        [
          'system orders {',
          '  expose api -> "Place order"',
          '  expose admin -> "Refund"',
          '}',
          'web           -> orders.api          : HTTPS',
          'orders.admin --> web                 : 200',
          'web          ->> orders.api',
          'web           -x orders.admin        : drops',
          'web           -> orders.api .planned : later',
          'a.b           -> orders.api',
          '',
        ].join('\n'),
      );
    });

    it('keeps dotted references tight in use case, alt and par steps', () => {
      const src = 'usecase "U" {\nweb->orders.api : POST /orders\nalt "Down" {\npar {\norders.api-->web:503\n}\n}  alt "Up" {\norders.api --> web : 201\n}\n}\n';
      expect(format(src)).toBe(
        'usecase "U" {\n  web -> orders.api : POST /orders\n  alt "Down" {\n    par {\n      orders.api --> web : 503\n    }\n  } alt "Up" {\n    orders.api --> web : 201\n  }\n}\n',
      );
    });

    it('keeps dotted references tight in chains and lines it cannot align', () => {
      expect(format('web  ->  orders.api  ->  db\n')).toBe('web -> orders.api -> db\n');
    });

    it('lays out system blocks in one-line and multi-line forms', () => {
      expect(format('system   orders   "Orders"   @orders   {   }\n')).toBe('system orders "Orders" @orders { }\n');
      expect(format('system orders{\nfrom   "orders.proschi"\n     expose api->"Place order"\nexpose   admin  "Admin"   ->   "Refund"\n}\n')).toBe(
        'system orders {\n  from "orders.proschi"\n  expose api -> "Place order"\n  expose admin "Admin" -> "Refund"\n}\n',
      );
      expect(format('system orders "Orders" {\n  capacity {\nrps   500\n      latency 20ms\n  }\n}\n')).toBe('system orders "Orders" {\n  capacity {\n    rps 500\n    latency 20ms\n  }\n}\n');
      expect(format('system orders {\ncapacity {   rps 500   latency  20ms }\n}\n')).toBe('system orders {\n  capacity { rps 500 latency 20ms }\n}\n');
    });

    it('keeps every kind of from path verbatim', () => {
      for (const path of ['teams/orders.proschi', 'git:github.com/acme/orders//design/orders.proschi@v2.3.0', 'https://example.com/orders.proschi', 'cloud:orders:latest', 'cloud:orders:2026-11-01', 'cloud:acme/orders//sub/path:latest']) {
        const src = `system orders {\n  from "${path}"\n  expose api -> "Place order"\n}\nweb -> orders.api\n`;
        expect(format(src)).toBe(src);
      }
    });

    it('keeps comments and tidies blank lines in and around a system', () => {
      const src = '# Orders team\n\n\nsystem orders "Orders" { # the box\n\n  # its design\n  from "orders.proschi"   # pinned\n\n\n  expose api -> "Place order"\n\n}\n\n\nweb -> orders.api # calls it\n';
      expect(format(src)).toBe(
        '# Orders team\n\nsystem orders "Orders" { # the box\n  # its design\n  from "orders.proschi" # pinned\n\n  expose api -> "Place order"\n}\n\nweb -> orders.api # calls it\n',
      );
    });

    it('indents a system inside a group', () => {
      expect(format('group g {\nsystem orders {\nexpose api -> "U"\n}\n}\n')).toBe('group g {\n  system orders {\n    expose api -> "U"\n  }\n}\n');
    });

    it('keeps the meaning and is idempotent on systems', () => {
      const src = 'web [React]\nsystem orders "Orders" @o { from "cloud:orders:latest"\n}\nsystem billing{\n capacity {\n rps 10\n }\n expose pay->"Pay"\n}\nweb->orders.api:x\nweb -> billing.pay\nusecase "U" {\nweb->billing.pay:POST\n}\n';
      const once = format(src);
      expect(meaning(once)).toEqual(meaning(src));
      expect(format(once)).toBe(once);
    });
  });
});
