/**
 * Read-only scrollable panel for command output that is a view of the session,
 * not a turn in it: `/help`, `/hotkeys`, `/palette`, `/status`.
 *
 * These commands used to dump their whole output into the transcript, which
 * pushed the conversation off screen every time a user asked what the session
 * was doing — and left the answer stranded in the log, above every later reply.
 * The panel is pi's selector shape instead: it takes over the editor slot, owns
 * the keyboard while it is open, and leaves nothing behind when it closes.
 *
 * Content arrives already rendered (ANSI allowed) and is soft-wrapped once per
 * width; the panel never re-derives it, so what a caller hands over is exactly
 * what the user reads.
 * @module @deepseek-ai/dsh-tui/components/panel
 */
import { type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Palette } from './theme.ts';
/**
 * One scrollable page of pre-rendered lines in the editor slot.
 *
 * The panel is inert except for its own scroll keys: ↑/↓ by a row, PgUp/PgDn by
 * a page, `g`/`G` (and Home/End) to either end, Esc or Ctrl+C to close. Every
 * other key is swallowed rather than forwarded, so a keystroke aimed at the
 * panel can never reach the editor behind it.
 */
export declare class ScrollablePanel implements Component, Focusable {
    private readonly title;
    private readonly lines;
    private readonly rows;
    private readonly palette;
    private readonly onClose;
    /** Set by the TUI on focus; the panel shows no cursor, so it only tracks it. */
    focused: boolean;
    /** First visible content row. */
    private offset;
    /** Wrapped content for {@link wrappedWidth}; recomputed when the width changes. */
    private wrapped;
    private wrappedWidth;
    /**
     * @param title - dim heading, shown above the content.
     * @param lines - pre-rendered content rows; ANSI is preserved, empty rows are kept.
     * @param rows - the panel's total row budget, read per render so a resize applies.
     * @param palette - active role palette.
     * @param onClose - called on Esc or Ctrl+C; the caller closes the overlay.
     */
    constructor(title: string, lines: readonly string[], rows: () => number, palette: Palette, onClose: () => void);
    invalidate(): void;
    /** Content rows for `width`, wrapped once and reused until the width changes. */
    private content;
    /** Visible content rows, once the title, footer, and leading blank are paid for. */
    private viewport;
    /** Last legal offset for the last measured width; zero while the content fits. */
    private maxOffset;
    private scrollTo;
    handleInput(data: string): void;
    render(width: number): string[];
}
