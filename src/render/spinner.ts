/**
 * The Claude Code working spinner's pure parts, ported from
 * pi-claude-code-ui/spinner.ts: the ping-pong glyph cycle, the whimsical verb
 * table, and the `Verb… (status)` line shown while a turn runs.
 *
 * This module owns no timer. It exports the frame table and an index-to-frame
 * function; driving them (a 170 ms interval, invalidating the component) belongs
 * to the component layer, which is the only place that knows when a turn starts
 * and stops.
 * @module @deepseek-ai/dsh-tui/render/spinner
 */

import { CLAUDE_COLORS, fg } from './palette.ts'

/**
 * The spinner glyphs, smallest to largest. `✳` is a Ghostty/macOS-safe glyph
 * choice; a terminal whose font lacks it shows a replacement box rather than a
 * misaligned cell.
 */
export const SPINNER_CHARS = ['·', '✢', '✳', '✶', '✻', '✽'] as const

/** The full ping-pong cycle: the glyphs grow, then shrink back. */
export const SPINNER_FRAMES: readonly string[] = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()]

/**
 * Milliseconds per frame. Snappier than a classic 250 ms so the glyph feels
 * alive, without turning every tick into a full-tree re-render storm.
 */
export const SPINNER_INTERVAL_MS = 170

/** After this long, the elapsed timer joins the status segment unconditionally. */
export const SHOW_TIMER_AFTER_MS = 30_000

/**
 * The frame for a tick counter.
 * @param tick - Monotonic tick count; the caller increments it every {@link SPINNER_INTERVAL_MS}.
 * @returns The glyph for this tick.
 */
export function spinnerFrame(tick: number): string {
  const index = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? SPINNER_CHARS[0]
}

/**
 * The verbs the spinner cycles through. Whimsy is the point: a long, varied
 * table keeps a slow turn from reading as a hung process.
 */
export const SPINNER_VERBS: readonly string[] = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Aligning',
  'Alchemizing',
  'Analyzing',
  'Animating',
  'Assembling',
  'Astral-projecting',
  'Architecting',
  'Baking',
  'Balancing',
  'Bamboozling',
  'Beaming',
  'Beboppin\'',
  'Befuddling',
  'Bespangling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Blueprinting',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brainstorming',
  'Brewing',
  'Buffering',
  'Bumbling',
  'Bunning',
  'Burrowing',
  'Busying',
  'Calculating',
  'Calibrating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Catalyzing',
  'Cerebrating',
  'Channeling',
  'Choreographing',
  'Churning',
  'Clattering',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Compiling',
  'Computing',
  'Concocting',
  'Conjuring',
  'Considering',
  'Contemplating',
  'Cooking',
  'Coordinating',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Dabbling',
  'Daydreaming',
  'Debugging',
  'Deciphering',
  'Deconstructing',
  'Deliberating',
  'Deducing',
  'Determining',
  'Diagnosing',
  'Dilly-dallying',
  'Discombobulating',
  'Distilling',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Engineering',
  'Envisioning',
  'Evaporating',
  'Experimenting',
  'Exploring',
  'Extrapolating',
  'Fabricating',
  'Fathoming',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambéing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Focusing',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Futzing',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Gathering',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Glitching',
  'Grappling',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honing',
  'Hustling',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Innovating',
  'Inspecting',
  'Ionizing',
  'Iterating',
  'Jamming',
  'Jitterbugging',
  'Juggling',
  'Julienning',
  'Knitting',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Mapping',
  'Marinating',
  'Meandering',
  'Meditating',
  'Metamorphosing',
  'Misting',
  'Mashing',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Nebulizing',
  'Nesting',
  'Noodling',
  'Nucleating',
  'Optimizing',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Outlining',
  'Overthinking',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Photosynthesizing',
  'Plotting',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Probing',
  'Processing',
  'Proofing',
  'Propagating',
  'Prototyping',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Querying',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Rebooting',
  'Recombobulating',
  'Refactoring',
  'Refining',
  'Reticulating',
  'Riffing',
  'Roosting',
  'Ruminating',
  'Sautéing',
  'Scampering',
  'Scheming',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Sleuthing',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stacking',
  'Stewing',
  'Sublimating',
  'Summoning',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Syncing',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmuting',
  'Troubleshooting',
  'Tuning',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unpacking',
  'Unravelling',
  'Untangling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Weaving',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Wondering',
  'Working',
  'Wrangling',
  'Yammering',
  'Zapping',
  'Zesting',
  'Zigzagging',
  'Zooming',
]

/**
 * Pick a spinner verb.
 * @param random - Source of randomness in [0, 1); injectable so a test can pin the verb.
 * @returns One verb from {@link SPINNER_VERBS}.
 */
export function pickVerb(random: () => number = Math.random): string {
  const index = Math.floor(random() * SPINNER_VERBS.length)
  return SPINNER_VERBS[index] ?? 'Working'
}

/**
 * Human-readable elapsed time: seconds, then minutes, then hours.
 * @param ms - Elapsed milliseconds.
 * @returns The formatted duration.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Group-separated count, the format the token readout uses.
 * @param value - The count.
 * @returns The formatted count.
 */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

/** What the status segment reports beside the verb. */
export interface WorkingStatus {
  /** Milliseconds since the turn started. */
  readonly elapsedMs: number
  /** Response tokens streamed so far; omit or pass 0 to hide the readout. */
  readonly tokens?: number
  /**
   * Reasoning state: `'thinking'` while the model reasons, or the finished
   * reasoning duration in milliseconds. Omit when the turn has no reasoning.
   */
  readonly thinking?: 'thinking' | number
  /** Thinking level shown as `with <level> effort`; omit for none. */
  readonly effort?: string
}

/**
 * The working line: the orange verb, then a recessed status segment carrying
 * reasoning state, streamed tokens, and elapsed time. The timer only appears
 * once something else is already shown or the turn passed
 * {@link SHOW_TIMER_AFTER_MS}, so a short turn stays quiet.
 * @param verb - The verb, from {@link pickVerb}.
 * @param status - What to report beside it.
 * @returns The rendered line.
 */
export function buildWorkingMessage(verb: string, status: WorkingStatus): string {
  const { elapsedMs, tokens = 0, thinking, effort } = status
  const parts: string[] = []
  if (thinking === 'thinking') {
    parts.push(`thinking${effort === undefined || effort === '' ? '' : ` with ${effort} effort`}`)
  } else if (typeof thinking === 'number') {
    parts.push(`thought for ${Math.max(1, Math.round(thinking / 1000))}s`)
  }
  if (tokens > 0) parts.push(`↓ ${formatCount(tokens)} tokens`)
  if (elapsedMs > SHOW_TIMER_AFTER_MS || thinking !== undefined || tokens > 0) {
    parts.push(formatDuration(elapsedMs))
  }
  const head = fg(CLAUDE_COLORS.claude, `${verb}…`)
  return parts.length > 0 ? `${head}${fg(CLAUDE_COLORS.inactive, ` (${parts.join(' · ')})`)}` : head
}
