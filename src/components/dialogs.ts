/**
 * pi-tui dialog and selector components for the terminal front door: the status
 * card, prompt-context line, model selector, agent-preset selector, theme
 * selector, resume picker, and user-question dialog, plus the model-choice,
 * preset-choice, and resume-candidate data they present.
 * @module @deepseek-ai/dsh-tui/components/dialogs
 */

import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import {
  type Agent,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo, LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, displayText, sanitizePastedText } from './text.ts'
import {
  dialogSelectTheme,
  isThemePreference,
  themePreferenceDescription,
  THEME_PREFERENCES,
  type Palette,
  type ThemePreferenceId,
} from './theme.ts'
import {
  renderTuiPromptTemplate,
  type TuiPromptTemplateToken,
} from '../prompt.ts'
import { plural, t, type PluralKey } from '../i18n/index.ts'

/** A selectable model advertised by a provider, with its display name, description, and reasoning metadata. */
export interface ModelChoice extends ModelSelection {
  modelName: string
  description?: string
  reasoning?: LlmModelReasoningInfo
}

/**
 * How far a pick reaches: to the default-model layer every future session
 * starts from, or to this session alone.
 *
 * Two keys rather than one because the two are genuinely different decisions —
 * "this is my model now" and "just for this piece of work" — and a picker that
 * silently wrote the user's global default on every Enter made the second one
 * unavailable.
 */
export type ModelSelectionScope = 'default' | 'session'

/**
 * The provider/model route, reasoning effort, and reach resolved from a model dialog.
 */
export interface ModelDialogSelection {
  choice: ModelChoice
  reasoningEffort: ReasoningEffortId | undefined
  scope: ModelSelectionScope
}

/**
 * Format a provider/model target as its `provider/model` label.
 * @param target - The LLM target.
 * @returns The `provider/model` label.
 */
export function targetLabel(target: ModelSelection): string {
  return `${target.provider}/${target.model}`
}

/**
 * Format a target compactly as its model name with any selected reasoning effort appended.
 * @param target - The LLM target.
 * @returns The compact `model [effort]` label.
 */
export function compactTargetLabel(target: ModelSelection): string {
  return `${target.model}${target.reasoningEffort === undefined ? '' : ` ${target.reasoningEffort}`}`
}

/**
 * Resolve the display label for a choice's reasoning effort.
 * @param choice - The model choice carrying advertised reasoning metadata.
 * @param effort - The selected effort, or `undefined` for provider default.
 * @returns The effort's display name, `Default`, or `undefined` when the model has no reasoning metadata.
 */
export function targetReasoningLabel(choice: ModelChoice, effort: ReasoningEffortId | undefined): string | undefined {
  if (effort === undefined) return choice.reasoning === undefined ? undefined : 'Default'
  return choice.reasoning?.efforts.find(candidate => candidate.id === effort)?.name ?? effort
}

/**
 * Derive the agent's initial LLM target from its logged request header or options.
 * @param agent - The driven agent.
 * @returns The initial target, or `undefined` when unset.
 */
export function initialTarget(agent: Agent): ModelSelection | undefined {
  const logged = agent.session.requestHeader()?.config
  if (logged !== undefined) {
    if (logged.reasoningEffort === undefined) {
      return { provider: logged.provider, model: logged.model }
    }
    return { provider: logged.provider, model: logged.model, reasoningEffort: logged.reasoningEffort }
  }
  if (agent.options.provider === undefined || agent.options.model === undefined) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/**
 * List every advertised model across registered providers, appending the current
 * target when a provider does not advertise it.
 * @param ctx - Context supplying the LLM service.
 * @param current - The current target, appended when unadvertised.
 * @returns The model choices, flattened across providers.
 */
export async function readModelChoices(
  ctx: Context,
  current: ModelSelection | undefined,
): Promise<ModelChoice[]> {
  const providers = ctx.llm.listProviders()
  const groups = await Promise.all(providers.map(async (provider) => {
    const advertised = await ctx.llm.listModels(provider.id)
    const models: LlmModelInfo[] = [...advertised]
    if (
      current?.provider === provider.id
      && !models.some(model => model.id === current.model)
    ) {
      models.push({ provider: provider.id, id: current.model, name: current.model })
    }
    return Promise.all(models.map(async (model): Promise<ModelChoice> => {
      const reasoning = (await ctx.llm.resolveModelInfo(provider.id, model.id)).reasoning
      return {
        provider: provider.id,
        model: model.id,
        modelName: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...reasoning === undefined ? {} : { reasoning },
      }
    }))
  }))
  return groups.flat()
}

/**
 * Format a diagnostic integer with grouping separators.
 * @param value - Integer to format.
 * @returns The grouped decimal string.
 */
export function formatDiagnosticNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Format a diagnostic timestamp as an ISO date-time in UTC.
 * @param value - Epoch milliseconds.
 * @returns The formatted UTC timestamp.
 */
export function formatDiagnosticTime(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/u, ' UTC')
}

/**
 * Format a pluralized count for a diagnostic row.
 *
 * The noun comes from the message table as a `.one`/`.other` pair rather than
 * from `singular + 's'`: `/status` translates its labels, and a row reading
 * `Agent idle · 42 events · 3 turns` in a Chinese card was half a translation.
 * @param value - Count.
 * @param key - The plural pair naming what is being counted.
 * @returns The formatted count, in the active locale.
 */
export function formatDiagnosticCount(value: number, key: PluralKey): string {
  return plural(value, key)
}

/**
 * Render a fixed-width filled meter bar for a percentage.
 * @param percent - Percentage in [0, 100].
 * @param palette - Active role palette.
 * @returns The rendered meter.
 */
export function diagnosticMeter(percent: number, palette: Palette): string {
  const width = 16
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width)
  return `${palette.dim('[')}${palette.accent('█'.repeat(filled))}${palette.dim(`${'░'.repeat(width - filled)}]`)}`
}

/** One `label: value` row of a status card group. */
export type StatusCardRow = readonly [label: string, value: string]

/** Bordered, grouped field card for one point-in-time status snapshot. */
export class StatusCardComponent implements Component {
  constructor(
    private readonly groups: readonly (readonly StatusCardRow[])[],
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const title = t('status.card.title')
    const labels = this.groups.flatMap(group => group.map(([label]) => `${label}:`))
    // Display columns, not UTF-16 code units: every other measurement in this
    // method (the truncation, the padding, the border) counts columns, and a
    // Chinese label is two columns per character. Mixing the two units clipped
    // `KV 缓存:` to `KV 缓存` and left the value column ragged.
    const naturalLabelWidth = Math.max(...labels.map(label => visibleWidth(label)))
    const naturalBodyWidth = Math.max(...this.groups.flatMap(group => group.map(([, value]) =>
      1 + naturalLabelWidth + 2 + visibleWidth(value))))
    const cardWidth = Math.min(
      Math.max(8, width),
      Math.max(visibleWidth(title) + 5, naturalBodyWidth + 4),
    )
    const innerWidth = Math.max(1, cardWidth - 4)
    const labelWidth = Math.min(
      naturalLabelWidth,
      Math.max(1, Math.floor(innerWidth / 3)),
    )
    const body: string[] = []
    for (const [groupIndex, group] of this.groups.entries()) {
      if (groupIndex > 0) body.push('')
      for (const [label, value] of group) {
        const plainLabel = truncateToWidth(`${label}:`, labelWidth, '')
        // Padded by columns for the same reason the width above is measured in
        // them: `padEnd` counts code units, so a Chinese label came out short.
        const padded = plainLabel + ' '.repeat(Math.max(0, labelWidth - visibleWidth(plainLabel)))
        const prefix = ` ${this.palette.dim(padded)}  `
        const continuation = ' '.repeat(1 + labelWidth + 2)
        const valueWidth = Math.max(1, innerWidth - visibleWidth(prefix))
        const wrapped = wrapTextWithAnsi(value, valueWidth)
        for (const [lineIndex, line] of wrapped.entries()) {
          body.push(`${lineIndex === 0 ? prefix : continuation}${line}`)
        }
      }
    }

    const clippedTitle = truncateToWidth(title, Math.max(1, cardWidth - 5), '')
    const topTail = '─'.repeat(Math.max(0, cardWidth - visibleWidth(clippedTitle) - 5))
    const top = `${this.palette.dim('╭─ ')}${this.palette.bold(this.palette.accent(clippedTitle))}${this.palette.dim(` ${topTail}╮`)}`
    const lines = [top]
    for (const line of body) {
      const clipped = truncateToWidth(line, innerWidth, '')
      lines.push(`${this.palette.dim('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${this.palette.dim('│')}`)
    }
    lines.push(this.palette.dim(`╰${'─'.repeat(Math.max(0, cardWidth - 2))}╯`))
    return lines
  }
}

/** The left/right template line rendered above the editor. */
export class PromptContextComponent implements Component {
  constructor(
    private readonly leftTemplate: readonly TuiPromptTemplateToken[],
    private readonly rightTemplate: readonly TuiPromptTemplateToken[],
    private readonly resolve: (name: string) => string | undefined,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const right = truncateToWidth(renderTuiPromptTemplate(this.rightTemplate, this.resolve), width, '')
    const rightWidth = visibleWidth(right)
    const leftCapacity = Math.max(0, width - rightWidth - (rightWidth === 0 ? 0 : 2))
    const left = truncateToWidth(renderTuiPromptTemplate(this.leftTemplate, this.resolve), leftCapacity, '')
    if (rightWidth === 0) return [left]
    const gap = ' '.repeat(Math.max(0, width - visibleWidth(left) - rightWidth))
    return [`${left}${gap}${right}`]
  }
}

/**
 * How the two keys that open a question's custom answer are named, wherever
 * they are named.
 *
 * Both keys are bound — `Tab` and `c` — and neither belongs to the keybinding
 * registry, so nothing generated from the registry can spell them: the dialog
 * footer, the dialog's own "nothing selected" refusal, the shortcut list
 * `/help`, `/hotkeys` and `?` print, and the README's question row are four
 * hand-written places that have to agree. Three of them read this constant;
 * the README is held to it by the docs suite.
 */
export const CUSTOM_ANSWER_KEYS = 'Tab/c'

/**
 * The custom-answer row as the question dialog's footer and the shortcut list
 * both print it, in English.
 *
 * The rendering surfaces read `dialog.question.customAnswer` per frame, so
 * `/lang` moves what the user sees; this constant is the English form the docs
 * suite holds the README to, which is a document that has no locale.
 */
export const CUSTOM_ANSWER_HINT = t('dialog.question.customAnswer', { keys: CUSTOM_ANSWER_KEYS }, 'en')

/** A user's answer to one question: chosen option labels and an optional custom answer. */
export interface QuestionSelection {
  selected: string[]
  custom?: string
}

/**
 * Render a bordered dialog frame around body lines with a titled top edge.
 * @param title - Dialog title shown in the top border.
 * @param body - Body lines.
 * @param width - Dialog width in columns.
 * @param palette - Active role palette.
 * @returns The framed dialog lines.
 */
export function renderDialog(
  title: string,
  body: readonly string[],
  width: number,
  palette: Palette,
): string[] {
  const innerWidth = Math.max(1, width - 4)
  const topLabel = ` ${displayText(title)} `
  const top = `╭${topLabel}${'─'.repeat(Math.max(0, width - visibleWidth(topLabel) - 2))}╮`
  const lines: string[] = [palette.accent(top)]
  for (const line of body) {
    const clipped = truncateToWidth(line, innerWidth, '')
    lines.push(`${palette.accent('│')} ${clipped}${' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${palette.accent('│')}`)
  }
  lines.push(palette.accent(`╰${'─'.repeat(Math.max(0, width - 2))}╯`))
  return lines
}

/**
 * Widest the route column grows before a row is truncated, leaving the rest of
 * a default-width dialog for the description beside it.
 */
const MODEL_ROUTE_COLUMN = 44

/**
 * Keyboard model selector: Claude Code's numbered picker — one row per route,
 * its description in a right-hand column, and the focused model's reasoning
 * effort on a line of its own under the list — over a filter box this
 * deployment needs and Claude Code does not, because a harness advertises every
 * model of every registered provider rather than a hand-written shortlist.
 *
 * The row numbers are ordinals, not shortcuts. Model names are full of digits
 * (`deepseek-v4-pro`), so a digit belongs to the filter; binding it to a row
 * would make the third character of a search jump the cursor somewhere else.
 *
 * Which is also why the session-only pick is `Ctrl+S` rather than `s`: every
 * printable key is a search character. The two writes are otherwise deliberately
 * symmetric — `Enter` saves the pick as the default, `Ctrl+S` spends it on this
 * session only, and the footer says both.
 */
export class ModelDialog implements Component {
  private list: SelectList
  private readonly filter = new Input()
  private readonly items: Map<string, SelectItem>
  private readonly choices: Map<string, ModelChoice>
  private readonly efforts: Map<string, ReasoningEffortId | undefined>
  private readonly currentValue: string | undefined

  constructor(
    choices: readonly ModelChoice[],
    current: ModelSelection | undefined,
    private readonly maxVisible: number,
    private readonly palette: Palette,
    private readonly done: (selection: ModelDialogSelection) => void,
    private readonly cancel: () => void,
  ) {
    this.items = new Map()
    this.choices = new Map()
    this.efforts = new Map()
    this.currentValue = current === undefined ? undefined : targetLabel(current)
    for (const choice of choices) {
      const value = targetLabel(choice)
      const isCurrent = current?.provider === choice.provider && current.model === choice.model
      this.choices.set(value, choice)
      this.efforts.set(
        value,
        isCurrent
          ? current.reasoningEffort ?? choice.reasoning?.defaultEffort
          : choice.reasoning?.defaultEffort,
      )
      this.items.set(value, {
        value,
        // Numbered by `filteredItems`, which is the only place that knows a
        // row's position among the rows actually on screen.
        label: displayText(value),
        description: this.describeChoice(choice, isCurrent),
      })
    }
    this.list = this.buildList(this.currentValue)
  }

  /** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
  private buildList(selectValue: string | undefined): SelectList {
    const items = this.filteredItems()
    // A route is the identity `/model <route>` takes, so the column has to be
    // wide enough to hold one: the list's 32-column default cut
    // `provider/model` pairs down to their shared provider prefix, which is the
    // half that does not tell two rows apart.
    const list = new SelectList(items, this.maxVisible, dialogSelectTheme(this.palette), {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: MODEL_ROUTE_COLUMN,
    })
    const index = selectValue === undefined ? 0 : items.findIndex(item => item.value === selectValue)
    list.setSelectedIndex(Math.max(0, index))
    // The list's own Enter is the default-saving pick; the session-only one is
    // taken above it, before the key ever reaches the list.
    list.onSelect = (item) => { this.confirm(item, 'default') }
    list.onCancel = this.cancel
    return list
  }

  /**
   * Items matching the filter box, as a case-insensitive substring over the
   * label, model name, and description, numbered in the order they appear.
   *
   * The numbering is applied here rather than at construction because a filtered
   * list that keeps its original ordinals reads as a broken list: the reader
   * counts rows, not catalog positions.
   */
  private filteredItems(): SelectItem[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    const matches = query === ''
      ? [...this.items.values()]
      : [...this.items.values()].filter((item) => {
        const choice = this.choices.get(item.value)
        /* v8 ignore next -- items and choices share the same keys. */
        if (choice === undefined) return false
        return [item.value, choice.modelName, choice.description ?? '']
          .some(field => field.toLocaleLowerCase().includes(query))
      })
    for (const [index, item] of matches.entries()) {
      item.label = `${String(index + 1)}. ${displayText(item.value)}`
    }
    return matches
  }

  private confirm(item: SelectItem, scope: ModelSelectionScope): void {
    const selected = this.choices.get(item.value)
    /* v8 ignore next -- SelectList only returns values built from `choices`. */
    if (selected === undefined) return
    this.done({ choice: selected, reasoningEffort: this.efforts.get(item.value), scope })
  }

  /**
   * The row's right-hand column: what the route is, in the provider's own
   * words. The reasoning effort is deliberately absent — it belongs to the
   * focused row alone and has its own adjustable line under the list, where it
   * cannot be truncated away by a long description.
   */
  private describeChoice(choice: ModelChoice, isCurrent: boolean): string {
    return [
      ...isCurrent ? ['current'] : [],
      displayText(choice.modelName),
      ...choice.description === undefined ? [] : [displayText(choice.description)],
    ].join(' — ')
  }

  /** Move the focused model's reasoning effort one step through its advertised ladder. */
  private cycleReasoningEffort(step: 1 | -1): void {
    const selectedItem = this.list.getSelectedItem()
    /* v8 ignore next -- the dialog is opened only for a non-empty catalog. */
    if (selectedItem === null) return
    const choice = this.choices.get(selectedItem.value)
    if (choice?.reasoning === undefined) return
    const current = this.efforts.get(selectedItem.value)
    // "Whatever the provider does" is only on the ladder when the model
    // advertises no default of its own; otherwise its default IS a rung.
    const efforts: Array<ReasoningEffortId | undefined> = [
      ...choice.reasoning.defaultEffort === undefined ? [undefined] : [],
      ...choice.reasoning.efforts.map(effort => effort.id),
    ]
    const currentIndex = efforts.indexOf(current)
    const next = efforts[(currentIndex + step + efforts.length) % efforts.length]
    this.efforts.set(selectedItem.value, next)
  }

  /**
   * The focused model's reasoning effort, stated as a line the arrow keys act
   * on — Claude Code's effort row — or as the reason there is nothing to adjust.
   */
  private renderEffortRow(): string {
    const selectedItem = this.list.getSelectedItem()
    /* v8 ignore next -- the dialog is opened only for a non-empty catalog. */
    if (selectedItem === null) return this.palette.dim(`◇ ${t('dialog.model.noFocus')}`)
    const choice = this.choices.get(selectedItem.value)
    if (choice?.reasoning === undefined) {
      return this.palette.dim(`◇ ${choice === undefined
        ? t('dialog.model.effortUnsupported')
        : t('dialog.model.effortUnsupportedFor', { model: displayText(choice.modelName) })}`)
    }
    const effort = this.efforts.get(selectedItem.value)
    const name = effort === undefined
      ? t('dialog.model.providerDefault')
      : displayText(targetReasoningLabel(choice, effort) ?? effort)
    // Marked only against a default the model actually advertises: calling the
    // provider's own fallback "(default)" would name a rung that is not there.
    const isDefault = choice.reasoning.defaultEffort !== undefined && effort === choice.reasoning.defaultEffort
    return `${this.palette.accent('◆')} ${t('dialog.model.effortRow', { effort: name })}${
      isDefault ? ` ${t('dialog.model.effortDefault')}` : ''}  ${this.palette.dim(t('dialog.model.adjust'))}`
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    // Closing beats filtering: `Esc` first clears a typed query, but `Ctrl+C`
    // is the terminal's universal "take this off my screen" and every other
    // surface here honours it.
    if (matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    // The arrows adjust the effort rather than the filter's cursor. A query
    // here is a few characters typed to reach one row, edited from its end;
    // the reasoning effort is the thing on screen that asks to be nudged.
    if (matchesKey(data, Key.left)) {
      this.cycleReasoningEffort(-1)
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.shift(Key.tab))) {
      this.cycleReasoningEffort(1)
    } else if (matchesKey(data, Key.ctrl('s'))) {
      const selectedItem = this.list.getSelectedItem()
      if (selectedItem !== null) this.confirm(selectedItem, 'session')
    } else if (matchesKey(data, Key.escape)) {
      if (this.filter.getValue() === '') this.cancel()
      else {
        this.filter.setValue('')
        this.list = this.buildList(undefined)
      }
    } else if (
      matchesKey(data, Key.up)
      || matchesKey(data, Key.down)
      || matchesKey(data, Key.enter)
    ) {
      this.list.handleInput(data)
    } else {
      const previous = this.filter.getValue()
      this.filter.focused = true
      this.filter.handleInput(data)
      if (this.filter.getValue() !== previous) {
        const selected = this.list.getSelectedItem()
        this.list = this.buildList(selected?.value)
      }
    }
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    this.filter.focused = true
    const results = this.filteredItems()
    const filterContent = truncateToWidth(this.filter.render(innerWidth).join(''), innerWidth, '')
    return renderDialog(t('dialog.model.title'), [
      filterContent,
      '',
      ...results.length === 0
        ? [this.palette.dim(`  ${t('dialog.model.noMatch')}`)]
        : this.list.render(innerWidth),
      '',
      ...results.length === 0 ? [] : [this.renderEffortRow(), ''],
      // Two rows: the first is how you move, the second is what each way of
      // leaving commits to. Folded into one line they truncate, and the line
      // that gets cut is the one naming the write.
      this.palette.dim(t('dialog.model.hintMove')),
      this.palette.dim(t('dialog.model.hintCommit')),
    ], width, this.palette)
  }
}

/**
 * One selectable agent preset, exactly the fields the roster reports about it.
 *
 * Structural rather than the roster's own `AgentPreset`: the preset package is
 * an optional mount, so nothing under `src/` may depend on its runtime, and the
 * absolute composition `path` it also carries has no place on a picker row.
 */
export interface PresetChoice {
  /** Preset id and directory name; also what `/preset <id>` takes. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for, when it published one. */
  description?: string
  /** Why the preset cannot compose a session, absent when it can. */
  broken?: string
}

/**
 * Keyboard agent-preset selector: the `ModelDialog` frame and filter box over
 * the deployment's preset roster.
 *
 * Broken presets stay on the list rather than being filtered out — a directory
 * that occupies an id with nothing usable in it is exactly what the reader
 * needs to see — and each states its own reason in the description column the
 * list already dims. Enter still yields them; the caller owns the refusal,
 * because it owns the sentence explaining what would have happened.
 */
export class PresetDialog implements Component {
  private list: SelectList
  private readonly filter = new Input()
  private readonly items: Map<string, SelectItem>
  private readonly choices: Map<string, PresetChoice>

  constructor(
    choices: readonly PresetChoice[],
    /** The preset this session runs, badged `current` and pre-selected. */
    private readonly current: string | undefined,
    /** The preset a session that names none gets, badged `default`. */
    private readonly defaultId: string | undefined,
    private readonly maxVisible: number,
    private readonly palette: Palette,
    private readonly done: (choice: PresetChoice) => void,
    private readonly cancel: () => void,
  ) {
    this.items = new Map()
    this.choices = new Map()
    for (const choice of choices) {
      this.choices.set(choice.id, choice)
      this.items.set(choice.id, {
        value: choice.id,
        label: displayText(choice.id),
        description: this.describeChoice(choice),
      })
    }
    this.list = this.buildList(current)
  }

  /** Build a SelectList over the currently filtered items, selecting `selectValue` when present. */
  private buildList(selectValue: string | undefined): SelectList {
    const items = this.filteredItems()
    const list = new SelectList(items, this.maxVisible, dialogSelectTheme(this.palette))
    const index = selectValue === undefined ? 0 : items.findIndex(item => item.value === selectValue)
    list.setSelectedIndex(Math.max(0, index))
    list.onSelect = (item) => { this.confirm(item) }
    list.onCancel = this.cancel
    return list
  }

  /** Items matching the filter box, as a case-insensitive substring over the id, name, and description. */
  private filteredItems(): SelectItem[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    if (query === '') return [...this.items.values()]
    return [...this.items.values()].filter((item) => {
      const choice = this.choices.get(item.value)
      /* v8 ignore next -- items and choices share the same keys. */
      if (choice === undefined) return false
      return [choice.id, choice.name ?? '', choice.description ?? '']
        .some(field => field.toLocaleLowerCase().includes(query))
    })
  }

  private confirm(item: SelectItem): void {
    const selected = this.choices.get(item.value)
    /* v8 ignore next -- SelectList only returns values built from `choices`. */
    if (selected === undefined) return
    this.done(selected)
  }

  /**
   * The row's description column: why the preset is unusable if it is, then how
   * this deployment relates to it, then what it says about itself.
   *
   * Badges lead and prose follows because the column is truncated from the
   * right. `current` and `default` are the two facts a reader is scanning the
   * list FOR — which composition is running and which one a new session would
   * get — and a sentence long enough to push either off the edge would hide
   * exactly the answer the picker was opened to give.
   */
  private describeChoice(choice: PresetChoice): string {
    const badges = [
      ...choice.id === this.current ? ['current'] : [],
      ...choice.id === this.defaultId ? ['default'] : [],
      ...choice.trust === 'system' ? ['built-in'] : ['local'],
    ].join(' · ')
    return [
      ...choice.broken === undefined ? [] : [`unavailable: ${displayText(choice.broken)}`],
      badges,
      ...choice.name === undefined ? [] : [displayText(choice.name)],
      ...choice.description === undefined ? [] : [displayText(choice.description)],
    ].join(' — ')
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    // Same rule as the model picker: `Esc` clears a typed query first, while
    // `Ctrl+C` closes outright from wherever the user is.
    if (matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.escape)) {
      if (this.filter.getValue() === '') this.cancel()
      else {
        this.filter.setValue('')
        this.list = this.buildList(undefined)
      }
    } else if (
      matchesKey(data, Key.up)
      || matchesKey(data, Key.down)
      || matchesKey(data, Key.enter)
    ) {
      this.list.handleInput(data)
    } else {
      const previous = this.filter.getValue()
      this.filter.focused = true
      this.filter.handleInput(data)
      if (this.filter.getValue() !== previous) {
        const selected = this.list.getSelectedItem()
        this.list = this.buildList(selected?.value)
      }
    }
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    this.filter.focused = true
    const results = this.filteredItems()
    const filterContent = truncateToWidth(this.filter.render(innerWidth).join(''), innerWidth, '')
    return renderDialog(t('dialog.preset.title'), [
      filterContent,
      '',
      ...results.length === 0
        ? [this.palette.dim(`  ${t('dialog.preset.noMatch')}`)]
        : this.list.render(innerWidth),
      '',
      this.palette.dim(t('dialog.preset.hint')),
    ], width, this.palette)
  }
}

/**
 * Keyboard theme selector, shared by `/theme` and the `/config` panel's Theme
 * row: one row per {@link ThemePreferenceId}, applied while the highlight moves
 * so the screen behind the dialog is the preview, and committed on Enter.
 *
 * Esc puts the theme the dialog opened on back, because a preview the user
 * scrolled past is not a choice they made — the same relation `/model`'s picker
 * has to the route it opened on.
 */
export class ThemeDialog implements Component {
  private readonly list: SelectList
  private preview: ThemePreferenceId

  /**
   * @param current - the theme in force when the dialog opened, restored on Esc.
   * @param palette - active role palette.
   * @param apply - paints one theme; called on every highlight move.
   * @param commit - persists the chosen theme; called once, on Enter.
   * @param close - closes the overlay.
   */
  constructor(
    private readonly current: ThemePreferenceId,
    private readonly palette: Palette,
    private readonly apply: (theme: ThemePreferenceId) => void,
    private readonly commit: (theme: ThemePreferenceId) => void,
    private readonly close: () => void,
  ) {
    this.preview = current
    const items: SelectItem[] = THEME_PREFERENCES.map(id => ({
      value: id,
      label: id,
      description: themePreferenceDescription(id),
    }))
    this.list = new SelectList(items, THEME_PREFERENCES.length, dialogSelectTheme(palette))
    this.list.setSelectedIndex(Math.max(0, THEME_PREFERENCES.indexOf(current)))
    this.list.onSelectionChange = (item) => {
      /* v8 ignore next -- the list is built from THEME_PREFERENCES, so every value is one. */
      if (!isThemePreference(item.value)) return
      this.preview = item.value
      this.apply(item.value)
    }
    this.list.onSelect = (item) => {
      /* v8 ignore next -- as above. */
      if (!isThemePreference(item.value)) return
      this.commit(item.value)
      this.close()
    }
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.preview !== this.current) this.apply(this.current)
      this.close()
      return
    }
    this.list.handleInput(data)
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    return renderDialog(t('dialog.theme.title'), [
      ...this.list.render(innerWidth),
      '',
      this.palette.dim(t('dialog.theme.hint')),
    ], width, this.palette)
  }
}

/** A resume selector row summarizing one session from metadata and its folded title. */
export interface ResumeCandidate {
  record: SessionRecord
  title: string
  /** Last observed change: live last-event time or artifact mtime, falling back to creation. */
  lastActivityAt: number
  /** Whether the session's workspace is the one the current session runs in, which selects the picker scope that lists it. */
  currentWorkspace: boolean
  /** The session's own workspace as a prompt-style label; the all-workspaces scope shows it per row. */
  workspaceLabel: string
  disabledReason?: string
}

/**
 * Build one resume selector row from a record, its batch-folded title, and a
 * metadata-derived activity time, deriving the workspace scope and any reason
 * the session cannot be resumed here. A workspace other than the current one
 * is a scope, not a disabled reason: resuming it hands the process off into
 * that directory. Rows carry no per-log detail beyond the title — route and
 * replay validity are checked by the Enter-time preflight against the one
 * chosen log.
 * @param record - The session record.
 * @param title - The session's batch-folded title, absent for an untitled log.
 * @param lastActivityAt - Metadata activity time; absent falls back to the header's creation time.
 * @param currentId - The current session id.
 * @param cwd - The CURRENT session's workspace, which decides the picker scope this row falls in.
 * @param formatWorkspace - Renders THIS record's own cwd as its prompt-style label.
 * @returns The summarized resume candidate.
 */
export function summarizeResumeCandidate(
  record: SessionRecord,
  title: string | undefined,
  lastActivityAt: number | undefined,
  currentId: SessionId,
  cwd: string | undefined,
  formatWorkspace: (cwd: string | undefined) => string,
): ResumeCandidate {
  let disabledReason: string | undefined
  if (record.header.id === currentId) disabledReason = 'current session'
  else if (record.live) disabledReason = 'session is already live in this runtime'
  else if (record.header.cwd === undefined) disabledReason = 'session has no recorded workspace'
  return {
    record,
    title: title ?? 'Untitled session',
    lastActivityAt: lastActivityAt ?? record.header.createdAt,
    currentWorkspace: record.header.cwd === cwd,
    workspaceLabel: formatWorkspace(record.header.cwd),
    ...disabledReason === undefined ? {} : { disabledReason },
  }
}

/** Which workspaces the resume picker currently lists. */
export type ResumeScope = 'workspace' | 'all'

/**
 * Full-viewport keyboard selector over detached, preflighted resume summaries.
 *
 * Two scopes over one candidate set: `workspace` (the default) lists only the
 * current session's workspace, `all` lists every workspace and labels each row
 * with its own. Tab toggles between them; the search query and selection reset
 * on a scope change so the highlighted row always belongs to the visible list.
 *
 * The picker opens before the session scan settles: an `undefined` candidate
 * set renders a loading placeholder that keeps input away from the editor,
 * and `setCandidates` swaps the scanned rows in without replacing the overlay.
 */
export class ResumePicker implements Component, Focusable {
  private readonly search = new Input()
  private pasteBuffer: string | undefined
  private selectedIndex = 0
  private error = ''
  private scope: ResumeScope = 'workspace'
  private candidates: readonly ResumeCandidate[] | undefined
  focused = false

  constructor(
    candidates: readonly ResumeCandidate[] | undefined,
    private readonly maxVisible: number,
    private readonly workspaceLabel: string,
    private readonly viewportRows: () => number,
    private readonly palette: Palette,
    private readonly done: (candidate: ResumeCandidate) => void,
    private readonly cancel: () => void,
  ) {
    this.candidates = candidates
  }

  invalidate(): void {
    this.search.invalidate()
  }

  /**
   * Narrow the picker to a query the user already typed.
   *
   * `/resume <session>` is the same selection as `/resume` plus a search term,
   * so it opens the same picker with the term already in its search box rather
   * than resuming behind the user's back: the row still has to be looked at
   * and confirmed, and Escape still clears the query instead of the overlay.
   * @param query - the argument text, verbatim.
   */
  setQuery(query: string): void {
    this.search.setValue(query)
    this.selectedIndex = 0
    this.invalidate()
  }

  /**
   * Replace the loading placeholder with the scanned candidate set.
   * @param candidates - the summarized rows the finished scan produced.
   */
  setCandidates(candidates: readonly ResumeCandidate[]): void {
    this.candidates = candidates
    this.selectedIndex = 0
    // A still-loading error is false the moment rows exist.
    this.error = ''
    this.invalidate()
  }

  /** Candidates in the active scope, before the search query narrows them. */
  private scoped(): ResumeCandidate[] {
    const candidates = this.candidates ?? []
    return this.scope === 'all'
      ? [...candidates]
      : candidates.filter(candidate => candidate.currentWorkspace)
  }

  private filtered(): ResumeCandidate[] {
    const query = this.search.getValue().trim().toLocaleLowerCase()
    const scoped = this.scoped()
    if (query === '') return scoped
    // The workspace label only distinguishes rows once it is on screen, so it
    // joins the searchable text exactly in the scope that shows it.
    return scoped.filter(candidate => candidate.title.toLocaleLowerCase().includes(query)
      || candidate.record.header.id.toLocaleLowerCase().includes(query)
      || (this.scope === 'all' && candidate.workspaceLabel.toLocaleLowerCase().includes(query)))
  }

  private visibleCandidateCount(): number {
    // The all-workspaces scope adds a per-row workspace line, so a row costs
    // one more terminal row there than in the single-workspace scope.
    const rowHeight = this.scope === 'all' ? 4 : 3
    const candidateBudget = Math.max(1, Math.floor((Math.max(1, this.viewportRows()) - 13) / rowHeight))
    return Math.min(this.maxVisible, candidateBudget)
  }

  private handleBracketedPaste(data: string): boolean {
    const start = data.indexOf(BRACKETED_PASTE_START)
    if (this.pasteBuffer === undefined && start < 0) return false
    if (this.pasteBuffer === undefined) {
      const prefix = data.slice(0, start)
      if (prefix !== '') this.handleInput(prefix)
      this.pasteBuffer = data.slice(start + BRACKETED_PASTE_START.length)
    } else {
      this.pasteBuffer += data
    }
    const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END)
    if (end < 0) return true
    const pasted = sanitizePastedText(this.pasteBuffer.slice(0, end))
    const remaining = this.pasteBuffer.slice(end + BRACKETED_PASTE_END.length)
    this.pasteBuffer = undefined
    const previous = this.search.getValue()
    this.search.handleInput(`${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}`)
    if (this.search.getValue() !== previous) {
      this.selectedIndex = 0
      this.error = ''
    }
    if (remaining !== '') this.handleInput(remaining)
    this.invalidate()
    return true
  }

  handleInput(data: string): void {
    if (this.handleBracketedPaste(data)) return
    const filtered = this.filtered()
    if (matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (matchesKey(data, Key.escape)) {
      if (this.search.getValue() === '') this.cancel()
      else {
        this.search.setValue('')
        this.selectedIndex = 0
        this.error = ''
      }
    } else if (matchesKey(data, Key.up)) {
      this.selectedIndex = filtered.length === 0
        ? 0
        : (this.selectedIndex + filtered.length - 1) % filtered.length
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = filtered.length === 0 ? 0 : (this.selectedIndex + 1) % filtered.length
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.visibleCandidateCount())
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(
        Math.max(0, filtered.length - 1),
        this.selectedIndex + this.visibleCandidateCount(),
      )
    } else if (matchesKey(data, Key.tab)) {
      this.scope = this.scope === 'workspace' ? 'all' : 'workspace'
      this.search.setValue('')
      this.selectedIndex = 0
      this.error = ''
    } else if (matchesKey(data, Key.enter)) {
      const selected = filtered[this.selectedIndex]
      if (this.candidates === undefined) this.error = t('dialog.resume.stillLoading')
      else if (selected === undefined) this.error = t('dialog.resume.noSessionMatch')
      else if (selected.disabledReason !== undefined) this.error = selected.disabledReason
      else this.done(selected)
    } else {
      const previous = this.search.getValue()
      this.search.focused = this.focused
      this.search.handleInput(data)
      if (this.search.getValue() !== previous) {
        this.selectedIndex = 0
        this.error = ''
      }
    }
    this.invalidate()
  }

  /**
   * The scope line under the search box: the active scope with the current
   * workspace it means, and the inactive scope with the count Tab would reveal.
   */
  private renderScopeLine(): string {
    const candidates = this.candidates ?? []
    const inWorkspace = candidates.filter(candidate => candidate.currentWorkspace).length
    const active = this.scope === 'workspace'
      ? t('dialog.resume.scopeWorkspace', { label: displayText(this.workspaceLabel) })
      : t('dialog.resume.scopeAll', { count: candidates.length })
    const other = this.scope === 'workspace'
      ? t('dialog.resume.scopeAll', { count: candidates.length })
      : t('dialog.resume.scopeWorkspaceCount', { count: inWorkspace })
    return `${this.palette.accent(active)}${this.palette.dim(`  ⇥ ${other}`)}`
  }

  render(width: number): string[] {
    this.search.focused = this.focused
    const height = Math.max(1, this.viewportRows())
    const horizontalPadding = width >= 12 ? 2 : 0
    const contentWidth = Math.max(1, width - horizontalPadding * 2)
    const indent = ' '.repeat(horizontalPadding)
    const filtered = this.filtered()
    if (this.selectedIndex >= filtered.length) this.selectedIndex = Math.max(0, filtered.length - 1)
    const selected = filtered[this.selectedIndex]
    const position = selected === undefined ? 0 : this.selectedIndex + 1
    const title = this.candidates === undefined
      ? t('dialog.resume.title')
      : t('dialog.resume.titleCounted', { position, total: filtered.length })
    const lines: string[] = [
      '',
      `${indent}${this.palette.bold(this.palette.accent(title))}`,
      '',
    ]

    const searchInnerWidth = Math.max(1, contentWidth - 4)
    lines.push(`${indent}${this.palette.dim(`╭${'─'.repeat(Math.max(0, contentWidth - 2))}╮`)}`)
    const searchContent = this.search.render(searchInnerWidth).join('').replace(/^> /u, '⌕ ')
    const clippedSearch = truncateToWidth(searchContent, searchInnerWidth, '')
    lines.push(
      `${indent}${this.palette.dim('│')} ${clippedSearch}${' '.repeat(Math.max(0, searchInnerWidth - visibleWidth(clippedSearch)))} ${this.palette.dim('│')}`,
      `${indent}${this.palette.dim(`╰${'─'.repeat(Math.max(0, contentWidth - 2))}╯`)}`,
      '',
      `${indent}${this.renderScopeLine()}`,
      '',
    )

    const visibleCount = this.visibleCandidateCount()
    const start = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(visibleCount / 2),
      filtered.length - visibleCount,
    ))
    const end = Math.min(filtered.length, start + visibleCount)
    const push = (line: string): void => {
      lines.push(`${indent}${truncateToWidth(line, contentWidth, '…')}`)
    }
    for (let index = start; index < end; index += 1) {
      const candidate = filtered[index] as ResumeCandidate
      const active = index === this.selectedIndex
      const status = [
        candidate.disabledReason === 'current session' ? 'current' : undefined,
        candidate.record.live ? 'live' : undefined,
        candidate.record.persisted ? 'persisted' : undefined,
      ].filter((value): value is string => value !== undefined).join(' · ')
      const lead = `${active ? '❯' : ' '} ${displayText(candidate.title)}`
      push(active ? this.palette.bold(this.palette.accent(lead)) : lead)
      push(this.palette.dim(`  ${new Date(candidate.lastActivityAt).toISOString()} · ${status} · ${displayText(candidate.record.header.id)}`))
      // Only the all-workspaces scope mixes directories, so the per-row
      // workspace is redundant in the scope that already names one.
      if (this.scope === 'all') {
        push(this.palette.dim(`  ${t('dialog.resume.workspaceRow', { label: displayText(candidate.workspaceLabel) })}`))
      }
      if (candidate.disabledReason !== undefined) {
        push(this.palette.warning(`  ${t('dialog.resume.unavailable', { reason: displayText(candidate.disabledReason) })}`))
      }
    }
    if (this.candidates === undefined) push(this.palette.dim(t('dialog.resume.loading')))
    else if (filtered.length === 0) push(this.palette.warning(t('dialog.resume.noMatch')))
    if (this.error !== '') {
      lines.push('')
      push(this.palette.error(displayText(this.error)))
    }

    const footer = `${indent}${this.palette.dim(t('dialog.resume.hint'))}`
    while (lines.length < height - 2) lines.push('')
    lines.push(footer, '')
    return lines.slice(0, height)
  }
}

interface SelectedBlockPage {
  offset: number
  size: number
  maxOffset: number
}

/** Inline dialog for one user question with option or custom-answer modes. */
export class QuestionDialog implements Component, Focusable {
  private selectedIndex = 0
  private selected = new Set<number>()
  private headerPage: SelectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
  private selectedBlockPage: SelectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
  private mode: 'options' | 'custom'
  private error = ''
  private readonly input = new Input()
  private readonly options: NonNullable<AskUserQuestionItem['options']>
  focused = false

  constructor(
    private readonly question: AskUserQuestionItem,
    private readonly position: number,
    private readonly total: number,
    private readonly unanswered: number,
    private readonly maxVisible: number,
    private readonly maxHeight: () => number,
    private readonly palette: Palette,
    private readonly done: (selection: QuestionSelection) => void,
    private readonly cancel: () => void,
  ) {
    this.options = question.options ?? []
    this.mode = this.options.length > 0 ? 'options' : 'custom'
    this.input.onSubmit = (value) => { this.submitCustom(value) }
    this.input.onEscape = () => {
      if (this.options.length > 0) {
        this.mode = 'options'
        this.error = ''
      } else {
        this.cancel()
      }
    }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  handleInput(data: string): void {
    this.invalidate()
    if (matchesKey(data, Key.pageUp)) {
      this.pageBackward()
      return
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageForward()
      return
    }
    // Interrupt before the mode branch, so it works in the custom editor too.
    // `Esc` there is the editor's own "back to the options" (see `onEscape`),
    // which left the dialog with no way out at all once the option list had
    // been traded for the box: every key the editor does not claim is a
    // character it types.
    if (matchesKey(data, Key.ctrl('c'))) {
      this.cancel()
      return
    }
    if (this.mode === 'custom') {
      this.input.focused = this.focused
      this.input.handleInput(data)
      return
    }
    const options = this.options
    if (matchesKey(data, Key.up)) {
      this.selectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
      this.selectedIndex = this.selectedIndex === 0 ? options.length - 1 : this.selectedIndex - 1
    } else if (matchesKey(data, Key.down)) {
      this.selectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
      this.selectedIndex = this.selectedIndex === options.length - 1 ? 0 : this.selectedIndex + 1
    } else if (matchesKey(data, Key.space) && this.question.multiSelect) {
      if (this.selected.has(this.selectedIndex)) this.selected.delete(this.selectedIndex)
      else this.selected.add(this.selectedIndex)
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.question.multiSelect
        ? this.selectedOptionLabels()
        : [options[this.selectedIndex]?.label].filter((label): label is string => label !== undefined)
      const custom = this.question.multiSelect ? this.input.getValue().trim() : ''
      if (selected.length === 0 && custom === '') {
        this.error = t('dialog.question.selectOne', { keys: CUSTOM_ANSWER_KEYS })
        return
      }
      this.done({ selected, ...(custom === '' ? {} : { custom }) })
    } else if (matchesKey(data, Key.tab) || data.toLowerCase() === 'c') {
      this.mode = 'custom'
      this.selectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
      this.error = ''
    } else if (matchesKey(data, Key.escape)) {
      this.cancel()
    }
  }

  private submitCustom(value: string): void {
    const custom = value.trim()
    if (custom === '') {
      this.error = t('dialog.question.emptyAnswer')
      return
    }
    this.done({
      selected: this.question.multiSelect ? this.selectedOptionLabels() : [],
      custom,
    })
  }

  private selectedOptionLabels(): string[] {
    return [...this.selected]
      .sort((a, b) => a - b)
      .map(index => this.options[index]?.label)
      .filter((label): label is string => label !== undefined)
  }

  /** Page backward through an oversized option, then through question detail. */
  private pageBackward(): void {
    if (this.mode === 'options' && this.selectedBlockPage.offset > 0) {
      this.selectedBlockPage = {
        ...this.selectedBlockPage,
        offset: Math.max(0, this.selectedBlockPage.offset - this.selectedBlockPage.size),
      }
      return
    }
    this.headerPage = {
      ...this.headerPage,
      offset: Math.max(0, this.headerPage.offset - this.headerPage.size),
    }
  }

  /** Page forward through question detail, then through an oversized option. */
  private pageForward(): void {
    if (this.headerPage.offset < this.headerPage.maxOffset) {
      this.headerPage = {
        ...this.headerPage,
        offset: Math.min(
          this.headerPage.maxOffset,
          this.headerPage.offset + this.headerPage.size,
        ),
      }
      return
    }
    if (this.mode === 'custom') return
    this.selectedBlockPage = {
      ...this.selectedBlockPage,
      offset: Math.min(
        this.selectedBlockPage.maxOffset,
        this.selectedBlockPage.offset + this.selectedBlockPage.size,
      ),
    }
  }

  render(width: number): string[] {
    this.input.focused = this.focused
    const horizontalPadding = Math.min(2, Math.max(0, Math.floor((width - 1) / 2)))
    const innerWidth = Math.max(1, width - horizontalPadding * 2)
    const header = `${t('dialog.question.header', {
      position: this.position,
      total: this.total,
      unanswered: this.unanswered,
    })}${this.question.header === undefined ? '' : ` · ${displayText(this.question.header)}`}`
    const questionLines = wrapTextWithAnsi(
      this.palette.text(displayText(this.question.question)),
      innerWidth,
    )
    const contentLines = [...questionLines]
    const headerLines: string[] = [
      ...wrapTextWithAnsi(this.palette.dim(header), innerWidth),
      ...questionLines,
    ]
    // Supporting detail (e.g. the full plan under review) renders between the
    // question and the answer surface, kept out of option labels.
    if (this.question.detail !== undefined) {
      headerLines.push('')
      contentLines.push('')
      for (const line of wrapTextWithAnsi(displayText(this.question.detail), innerWidth)) {
        headerLines.push(line)
        contentLines.push(line)
      }
    }
    headerLines.push('')

    const customControls = [
      ...(this.options.length > 0 && this.question.multiSelect
        ? [t('dialog.question.selectedCount', { count: this.selected.size })]
        : []),
      t('dialog.question.submit'),
      t(this.options.length > 0 ? 'dialog.question.escOptions' : 'dialog.question.escCancel'),
    ]
    const customHint = this.palette.dim(customControls.join(' • '))
    const footerLines: string[] = []
    if (this.mode === 'custom') {
      for (const line of this.input.render(innerWidth)) footerLines.push(line)
      for (const line of wrapTextWithAnsi(customHint, innerWidth)) footerLines.push(line)
    } else {
      const controls = [
        // Both keys are named because both are bound: `c` is the one a hand
        // already on the option list reaches for, and a shortcut nobody is
        // told about is a shortcut nobody uses.
        t('dialog.question.customAnswer', { keys: CUSTOM_ANSWER_KEYS }),
        ...(this.options.length > 1 ? [t('dialog.question.navigate')] : []),
        ...(this.question.multiSelect ? [t('dialog.question.spaceToggle')] : []),
        t('dialog.question.submit'),
        t('dialog.question.escInterrupt'),
      ]
      const hint = this.palette.dim(controls.join(' • '))
      for (const line of wrapTextWithAnsi(hint, innerWidth)) footerLines.push(line)
    }
    if (this.error) {
      for (const line of wrapTextWithAnsi(this.palette.error(this.error), innerWidth)) footerLines.push(line)
    }
    const positionLines = this.mode === 'options' && this.options.length > this.maxVisible
      ? [this.palette.dim(`${this.selectedIndex + 1}/${this.options.length}`)]
      : []

    // Options receive only the rows left after fixed chrome and outer padding.
    // The final height window handles fixed chrome that cannot fit even alone.
    const paddingRows = 2
    const maxHeight = this.maxHeight()
    const availableForOptions = Math.max(
      this.mode === 'options' ? 4 : 1,
      maxHeight - paddingRows - headerLines.length - positionLines.length - footerLines.length,
    )

    const body: string[] = [...headerLines]
    const optionLines: string[] = []
    if (this.mode === 'custom') {
      for (const line of footerLines) body.push(line)
    } else {
      const optionBlocks = this.options.map((option, index) => this.renderOptionBlock(option, index, innerWidth))
      const { visibleBlocks, hiddenBefore, hiddenAfter } = this.windowBlocks(optionBlocks, availableForOptions, innerWidth)
      if (hiddenBefore > 0) optionLines.push(this.palette.dim(t('dialog.question.moreAbove', { count: hiddenBefore })))
      for (const block of visibleBlocks) {
        for (const line of block) optionLines.push(line)
      }
      if (hiddenAfter > 0) optionLines.push(this.palette.dim(t('dialog.question.moreBelow', { count: hiddenAfter })))
      for (const line of optionLines) body.push(line)
      for (const line of positionLines) body.push(line)
      for (const line of footerLines) body.push(line)
    }

    const rows = ['', ...body, '']
    let visibleRows = rows
    if (rows.length <= maxHeight) this.headerPage = { offset: 0, size: 1, maxOffset: 0 }
    if (rows.length > maxHeight && this.mode === 'options' && maxHeight >= 6) {
      const headerBudget = Math.max(
        0,
        maxHeight - optionLines.length - (this.error === '' ? 1 : 2),
      )
      const compactFooter = [
        ...this.error === ''
          ? []
          : [truncateToWidth(this.palette.error(t('dialog.question.error', { message: this.error })), innerWidth, '…')],
        this.compactOptionControls(
          innerWidth,
          headerBudget === 1 && contentLines.length > headerBudget,
        ),
      ]
      const compactHeader = this.compactQuestionHeader(contentLines, headerBudget, innerWidth)
      visibleRows = [...compactHeader, ...optionLines, ...compactFooter]
    } else if (rows.length > maxHeight && this.mode === 'custom' && maxHeight >= 2) {
      const compactFooterSource = [
        ...this.input.render(innerWidth),
        this.compactCustomControls(innerWidth),
        ...this.error === ''
          ? []
          : [truncateToWidth(this.palette.error(this.error), innerWidth, '…')],
      ]
      const footerBudget = Math.max(1, maxHeight - 1)
      const compactFooter = compactFooterSource.length <= footerBudget
        ? compactFooterSource
        : footerBudget === 1
          ? compactFooterSource.slice(0, 1)
          : [
            ...compactFooterSource.slice(0, 1),
            ...compactFooterSource.slice(-(footerBudget - 1)),
          ]
      const compactHeader = this.compactQuestionHeader(
        contentLines,
        Math.max(0, maxHeight - compactFooter.length),
        innerWidth,
      )
      visibleRows = [...compactHeader, ...compactFooter]
    }
    if (visibleRows.length > maxHeight) {
      visibleRows = maxHeight === 1
        ? [this.palette.dim(t('dialog.question.linesHidden', { count: visibleRows.length }))]
        : [
          this.palette.dim(t('dialog.question.linesHidden', { count: visibleRows.length - maxHeight + 1 })),
          ...visibleRows.slice(-(maxHeight - 1)),
        ]
    }
    return visibleRows.map((line) => {
      const bounded = truncateToWidth(line, innerWidth, '…')
      const pad = ' '.repeat(Math.max(0, innerWidth - visibleWidth(bounded)))
      const outerPad = ' '.repeat(horizontalPadding)
      return `${outerPad}${bounded}${pad}${outerPad}`
    })
  }

  /** Render one option as wrapped label and indented description lines. */
  private renderOptionBlock(
    option: NonNullable<AskUserQuestionItem['options']>[number],
    index: number,
    innerWidth: number,
  ): string[] {
    const cursor = index === this.selectedIndex ? '›' : ' '
    const number = `${index + 1}. `
    const mark = this.question.multiSelect
      ? this.selected.has(index) ? '[x] ' : '[ ] '
      : ''
    const labelPrefixPlain = ` ${cursor} ${number}${mark}`
    const labelPrefixWidth = visibleWidth(labelPrefixPlain)
    const labelBodyWidth = Math.max(1, innerWidth - labelPrefixWidth)
    const labelLines = wrapTextWithAnsi(displayText(option.label), labelBodyWidth)
    const continuation = ' '.repeat(labelPrefixWidth)
    const lines: string[] = []
    for (const [lineIndex, labelLine] of labelLines.entries()) {
      const prefix = lineIndex === 0 ? labelPrefixPlain : continuation
      const composed = `${prefix}${labelLine}`
      lines.push(index === this.selectedIndex ? this.palette.bold(this.palette.accent(composed)) : composed)
    }
    if (option.description !== undefined) {
      const descIndent = ' '.repeat(labelPrefixWidth)
      const descBodyWidth = Math.max(1, innerWidth - labelPrefixWidth)
      const descLines = wrapTextWithAnsi(displayText(option.description), descBodyWidth)
      for (const descLine of descLines) lines.push(`${descIndent}${this.palette.dim(descLine)}`)
    }
    return lines
  }

  /** Keep the question visible when fixed chrome must be compacted. */
  private compactQuestionHeader(
    contentLines: readonly string[],
    budget: number,
    innerWidth: number,
  ): string[] {
    if (budget <= 0) return []
    if (contentLines.length <= budget) {
      this.headerPage = { offset: 0, size: 1, maxOffset: 0 }
      return [...contentLines]
    }
    const pageSize = Math.max(1, budget - 1)
    const maxOffset = Math.max(0, contentLines.length - pageSize)
    const offset = Math.min(this.headerPage.offset, maxOffset)
    this.headerPage = { offset, size: pageSize, maxOffset }
    const keptLines = contentLines.slice(offset, offset + pageSize)
    if (budget === 1) {
      // A page is non-empty because pageSize is one and offset is clamped inside contentLines.
      return [keptLines[0] as string]
    }
    return [
      ...keptLines,
      this.pagerStatus(offset + 1, offset + keptLines.length, contentLines.length, innerWidth),
    ]
  }

  /** Keep Page Up / Page Down discoverable when a full pager status cannot fit. */
  private pagerStatus(first: number, last: number, total: number, innerWidth: number): string {
    const full = `… lines ${first}-${last}/${total} • PgUp/PgDn`
    const compact = `PgUp/PgDn ${first}/${total}`
    return this.palette.dim(truncateToWidth(
      visibleWidth(full) <= innerWidth ? full : compact,
      innerWidth,
      '…',
    ))
  }

  /** Render custom-mode controls on one row when the header must compact. */
  private compactCustomControls(innerWidth: number): string {
    const controls = [
      t('dialog.question.submit'),
      t(this.options.length > 0 ? 'dialog.question.escOptions' : 'dialog.question.escCancel'),
    ].join(' • ')
    const fallback = this.options.length > 0 ? '↵ Esc options' : 'Enter Esc cancel'
    const line = visibleWidth(controls) <= innerWidth ? controls : fallback
    return this.palette.dim(truncateToWidth(line, innerWidth, '…'))
  }

  /** Render a one-row option footer that retains every mode-specific control. */
  private compactOptionControls(innerWidth: number, showPager = false): string {
    const controls = [
      ...(this.options.length > 1 ? ['↑/↓'] : []),
      t('dialog.question.customAnswer', { keys: CUSTOM_ANSWER_KEYS }),
      ...(this.question.multiSelect ? [t('dialog.question.spaceToggle')] : []),
      'Enter',
      t('dialog.question.escInterrupt'),
      ...(showPager ? ['PgUp/PgDn'] : []),
    ].join(' • ')
    const optionNavigation = this.options.length > 1 ? '↑↓ ' : ''
    const fallback = showPager
      ? `P↑↓ ${optionNavigation}Tab${this.question.multiSelect ? ' S' : ''}↵Esc`
      : this.question.multiSelect ? `${optionNavigation}Tab Sp ↵Esc` : `${optionNavigation}Tab ↵ Esc`
    const line = visibleWidth(controls) <= innerWidth ? controls : fallback
    return this.palette.dim(truncateToWidth(line, innerWidth, '…'))
  }

  /**
   * Choose option blocks that fit while keeping the selected option visible.
   * Omitted blocks are counted at each end for explicit overflow markers.
   */
  private windowBlocks(
    blocks: readonly string[][],
    budget: number,
    innerWidth: number,
  ): { visibleBlocks: string[][]; hiddenBefore: number; hiddenAfter: number } {
    const totalLines = blocks.reduce((sum, block) => sum + block.length, 0)
    if (totalLines <= budget && blocks.length <= this.maxVisible) {
      return { visibleBlocks: [...blocks], hiddenBefore: 0, hiddenAfter: 0 }
    }
    // `blocks` is dense and selectedIndex is derived from the same options.
    let start = this.selectedIndex
    let end = this.selectedIndex + 1
    /* v8 ignore next -- selectedIndex stays inside [0, options.length). */
    let used = blocks[this.selectedIndex]?.length ?? 0
    const markerLines = (before: number, after: number): number =>
      (before > 0 ? 1 : 0) + (after > 0 ? 1 : 0)
    const fits = (nextStart: number, nextEnd: number, nextUsed: number): boolean =>
      nextEnd - nextStart <= this.maxVisible
      && nextUsed + markerLines(nextStart, blocks.length - nextEnd) <= budget
    const selectedMarkers = markerLines(start, blocks.length - end)
    if (used + selectedMarkers > budget) {
      /* v8 ignore next -- selectedIndex stays inside [0, options.length). */
      const selectedBlock = blocks[this.selectedIndex] ?? []
      const hiddenBefore = start
      const hiddenAfter = blocks.length - end
      const pageSize = budget - selectedMarkers - 1
      const maxOffset = Math.max(0, selectedBlock.length - pageSize)
      const offset = Math.min(this.selectedBlockPage.offset, maxOffset)
      this.selectedBlockPage = { offset, size: pageSize, maxOffset }
      const keptLines = selectedBlock.slice(offset, offset + pageSize)
      const first = offset + 1
      const last = offset + keptLines.length
      const overflow = this.pagerStatus(first, last, selectedBlock.length, innerWidth)
      return {
        visibleBlocks: [[...keptLines, overflow]],
        hiddenBefore,
        hiddenAfter,
      }
    }
    this.selectedBlockPage = { offset: 0, size: 1, maxOffset: 0 }
    let expanded = true
    while (expanded && (start > 0 || end < blocks.length)) {
      expanded = false
      if (end < blocks.length) {
        /* v8 ignore next -- guarded by `end < blocks.length` above. */
        const next = blocks[end]?.length ?? 0
        if (fits(start, end + 1, used + next)) {
          used += next
          end += 1
          expanded = true
          continue
        }
      }
      if (start > 0) {
        /* v8 ignore next -- guarded by `start > 0` above. */
        const previous = blocks[start - 1]?.length ?? 0
        if (fits(start - 1, end, used + previous)) {
          used += previous
          start -= 1
          expanded = true
        }
      }
    }
    return {
      visibleBlocks: blocks.slice(start, end),
      hiddenBefore: start,
      hiddenAfter: blocks.length - end,
    }
  }
}
