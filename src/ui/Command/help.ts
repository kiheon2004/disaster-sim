/**
 * Phase 37 (§14) — what the command bar's help shows: example sentences taken from the corpus (the sentences the
 * parser is tested with, so an example in the help is one that is promised to work), the canonical grammar as a table,
 * and the bar's keys. The grammar rows are written by hand next to the grammar's own header (command/canonical.ts);
 * a test checks that no verb is missing.
 */
import type { MessageKey } from '@/i18n/i18n';
import type { Verb } from '@/command/canonical';
// (types only: the corpus itself is large and is loaded when the help is opened — see HelpPanel)
import type { CorpusClass, CorpusFile, CorpusLang } from '@/command/corpus/index';

export interface HelpExample {
  text: string;
  /** The canonical commands the sentence means. */
  canonical: string[];
}

export interface HelpClass {
  class: CorpusClass;
  examples: HelpExample[];
}

/** Examples shown per sentence class. */
export const EXAMPLES_PER_CLASS = 5;

/**
 * Per sentence class (in the order given: the corpus' own list of classes) the first sentences of the language that
 * mean different commands — the corpus lists the plain wording of a command before its variants (no spaces, other
 * endings), so this picks the plain ones. Classes without a runnable sentence (the ones that must be refused) are
 * left out.
 */
export function helpExamples(files: readonly CorpusFile[], lang: CorpusLang, classes: readonly CorpusClass[], perClass = EXAMPLES_PER_CLASS): HelpClass[] {
  const out: HelpClass[] = [];
  for (const cls of classes) {
    const seen = new Set<string>();
    const examples: HelpExample[] = [];
    for (const f of files) {
      if (f.class !== cls || f.lang !== lang) continue;
      for (const c of f.cases) {
        if (examples.length >= perClass) break;
        if (!('expect' in c)) continue;
        const key = c.expect.join('\n');
        if (seen.has(key)) continue;
        seen.add(key);
        examples.push({ text: c.text, canonical: c.expect });
      }
    }
    if (examples.length) out.push({ class: cls, examples });
  }
  return out;
}

/** The canonical grammar, one row per form: the verb, how it is written, what it does. */
export const GRAMMAR: readonly (readonly [Verb, string, MessageKey])[] = [
  ['place', 'place <type>[:<preset>] [count=N] [at=<place>] [along=<road>] [side=left|right|north|south|east|west] [gap=<m>] [floors=N] [heading=<°>]', 'cmd37.ui.g.place'],
  ['select', 'select <target> | select none', 'cmd37.ui.g.select'],
  ['add', 'add <target>', 'cmd37.ui.g.add'],
  ['remove', 'remove <target>', 'cmd37.ui.g.remove'],
  ['move', 'move <target> by=<dx,dy,dz> | move <target> to=<place>', 'cmd37.ui.g.move'],
  ['rotate', 'rotate <target> by=<°>', 'cmd37.ui.g.rotate'],
  ['scale', 'scale <target> x<k>', 'cmd37.ui.g.scale'],
  ['set', 'set <target> [x=<m>] [y=<m>] [z=<m>] [heading=<°>] [scale=<k>] [lift=<m>]', 'cmd37.ui.g.set'],
  ['align', 'align <target> axis=x|z mode=min|center|max ref=origin|footprint | align <target> edge=front|back ref=origin|footprint', 'cmd37.ui.g.align'],
  ['distribute', 'distribute <target> axis=x|z|auto [gaps]', 'cmd37.ui.g.distribute'],
  ['match', 'match <target> heading|height|scale [to=<target>]', 'cmd37.ui.g.match'],
  ['copy', 'copy <scale,heading,params,physics,structure> from=<target> to=<target>', 'cmd37.ui.g.copy'],
  ['group', 'group <target> [name="…"]', 'cmd37.ui.g.group'],
  ['ungroup', 'ungroup <target>', 'cmd37.ui.g.ungroup'],
  ['rename', 'rename <target> "…"', 'cmd37.ui.g.rename'],
  ['hide', 'hide <target>', 'cmd37.ui.g.hide'],
  ['show', 'show <target>', 'cmd37.ui.g.show'],
  ['lock', 'lock <target>', 'cmd37.ui.g.lock'],
  ['unlock', 'unlock <target>', 'cmd37.ui.g.unlock'],
  ['delete', 'delete <target>', 'cmd37.ui.g.delete'],
  ['duplicate', 'duplicate <target> [offset=<dx,dz>]', 'cmd37.ui.g.duplicate'],
  ['terrain', 'terrain raise|lower|flatten|smooth <area> [by=<m>] [to=<m>]', 'cmd37.ui.g.terrain'],
  ['paint', 'paint <area> ground=<name>', 'cmd37.ui.g.paint'],
  ['road', 'road <place> -> <place> [preset=<name>]', 'cmd37.ui.g.road'],
  ['forest', 'forest <area> [density=<v>] [seed=N]', 'cmd37.ui.g.forest'],
  ['disaster', 'disaster <type> [at=<place>] [<field>=<value> …] [start=<s>] [now]', 'cmd37.ui.g.disaster'],
  ['disaster', 'disaster <instance> move to=<place> | disaster <instance> delete|stop|pause|resume', 'cmd37.ui.g.instance'],
  ['run', 'run', 'cmd37.ui.g.run'],
  ['pause', 'pause', 'cmd37.ui.g.pause'],
  ['reset', 'reset', 'cmd37.ui.g.reset'],
  ['speed', 'speed=<k>', 'cmd37.ui.g.speed'],
  ['focus', 'focus <target> | focus at=<place>', 'cmd37.ui.g.focus'],
  ['undo', 'undo', 'cmd37.ui.g.undo'],
  ['redo', 'redo', 'cmd37.ui.g.redo'],
  ['count', 'count <target> | count disasters|groups|roads|sim', 'cmd37.ui.g.count'],
  ['list', 'list <target> | list disasters|groups|roads|sim', 'cmd37.ui.g.list'],
  ['measure', 'measure <target> | measure <place> <place>', 'cmd37.ui.g.measure'],
  ['info', 'info <target> | info disasters|groups|roads|sim', 'cmd37.ui.g.info'],
];

/** The terms the rows above use. */
export const GRAMMAR_TERMS: readonly (readonly [string, string, MessageKey])[] = [
  ['<target>', 'selection | last | it | all | #<id> | group:"…" | name:"…" | type:<type>[:<preset>]  [where <condition> {and <condition>}] [largest | tallest | nearest <place>] [first N]', 'cmd37.ui.g.term.target'],
  ['<condition>', 'floors|slope|height >=|<=|>|<|= <n> | near <place> r=<m> | on road [<road>] | hidden | locked | visible | unlocked | warning[=<code>]', 'cmd37.ui.g.term.condition'],
  ['<place>', '<x>,<z> | node:<id> | seg:<id>[@<0…1>] | junction | cursor | view | center | selection | last | #<id> | group:"…" | name:"…" | feature:<id> | north|south|east|west(<place>[,<m>]) | next(<place>)', 'cmd37.ui.g.term.place'],
  ['<road>', 'seg:<id> | road:<node>-<node> | road:main | road:any | road:nearest(<place>)', 'cmd37.ui.g.term.road'],
  ['<area>', 'rect <x0>,<z0>,<x1>,<z1> | circle <place> r=<m> | around <target> r=<m> | feature:<id>', 'cmd37.ui.g.term.area'],
  ['<instance>', 'p<k> | <type>[#<n>] | all', 'cmd37.ui.g.term.instance'],
];

/**
 * The bar's keys (also listed in the help dialog of the top bar): the key, what it does, and whether it works from
 * anywhere (true) or while the bar's input has the keyboard (false).
 */
export const COMMAND_KEYS: readonly (readonly [string, MessageKey, boolean])[] = [
  ['/', 'cmd37.ui.key.slash', true],
  ['Ctrl/⌘ + K', 'cmd37.ui.key.ctrlK', true],
  ['Enter', 'cmd37.ui.key.enter', false],
  ['Esc', 'cmd37.ui.key.esc', false],
  ['↑ / ↓', 'cmd37.ui.key.history', false],
  ['Tab / Shift + Tab', 'cmd37.ui.key.tab', false],
];

/** Keys only the bar's own help lists (they need the bar's context to make sense). */
export const COMMAND_KEYS_MORE: readonly (readonly [string, MessageKey])[] = [
  ['1 – 9', 'cmd37.ui.key.digits'],
  ['Ctrl/⌘ + Enter', 'cmd37.ui.key.scriptRun'],
];
