//! The visible 40 by 512 cells of the private setup-token PTY.

use std::ops::Range;
use std::sync::atomic::{compiler_fence, Ordering};

use super::SecretBytes;

pub(super) const PTY_ROWS: u16 = 40;
pub(super) const PTY_COLS: u16 = 512;
const ROWS: usize = PTY_ROWS as usize;
const COLS: usize = PTY_COLS as usize;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CellWidth {
    Single,
    Wide,
    Continuation,
}

#[derive(Clone, Copy)]
struct Cell {
    glyph: char,
    width: CellWidth,
}

impl Cell {
    const BLANK: Self = Self { glyph: ' ', width: CellWidth::Single };
    const CONTINUATION: Self = Self { glyph: ' ', width: CellWidth::Continuation };
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RowQuality {
    Exact,
    AmbiguousWidth,
    Uncertain,
}

pub(super) struct VisibleLine {
    pub(super) text: SecretBytes,
    pub(super) ambiguous_width: bool,
    pub(super) right_edge_blank: bool,
}

#[derive(Clone, Copy)]
struct UncertainColumn {
    furthest: usize,
    appending: bool,
}

#[derive(Default)]
struct Cursor {
    row: usize,
    col: usize,
    wrap_pending: bool,
    uncertain_col: Option<UncertainColumn>,
    uncertain_row: bool,
}

impl Cursor {
    fn end_wrap(&mut self) {
        self.wrap_pending = false;
        if let Some(drift) = &mut self.uncertain_col {
            drift.furthest = drift.furthest.min(COLS - 1);
        }
    }

    fn stop_appending(&mut self) {
        if let Some(drift) = &mut self.uncertain_col {
            drift.appending = false;
        }
    }

    fn anchor_column(&mut self, col: usize) {
        self.col = col;
        self.wrap_pending = false;
        self.uncertain_col = None;
    }

    fn move_column(&mut self, next: impl Fn(usize) -> usize) {
        self.end_wrap();
        self.stop_appending();
        self.col = next(self.col);
        if let Some(drift) = &mut self.uncertain_col {
            drift.furthest = next(drift.furthest);
        }
    }
}

#[derive(Clone, Copy)]
enum Parser {
    Ground,
    Escape,
    Csi { start: usize },
    Osc { start: usize, escape: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ControlFamily {
    C0,
    C1,
    Escape,
    Csi,
    CsiR,
    AltScreen,
    Osc,
    Osc133,
    IncompleteSequence,
}

impl ControlFamily {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::C0 => "c0",
            Self::C1 => "c1",
            Self::Escape => "escape",
            Self::Csi => "csi",
            Self::CsiR => "csi_r",
            Self::AltScreen => "alt_screen",
            Self::Osc => "osc",
            Self::Osc133 => "osc_133",
            Self::IncompleteSequence => "incomplete_sequence",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ScreenUncertainty {
    Unsupported(ControlFamily),
    UncertainRow,
}

pub(super) struct Screen {
    cells: Vec<Cell>,
    rows: [RowQuality; ROWS],
    // An error verified at its LF follows the row until it is edited or erased.
    verified_errors: [bool; ROWS],
    cursor: Cursor,
    autowrap: bool,
    hidden: bool,
    unsupported: Option<ControlFamily>,
    consumed: usize,
    parser: Parser,
}

impl Default for Screen {
    fn default() -> Self {
        Self {
            cells: vec![Cell::BLANK; ROWS * COLS],
            rows: [RowQuality::Exact; ROWS],
            verified_errors: [false; ROWS],
            cursor: Cursor::default(),
            autowrap: true,
            hidden: false,
            unsupported: None,
            consumed: 0,
            parser: Parser::Ground,
        }
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        for cell in &mut self.cells {
            // Keep the erase even if the allocation is about to be released.
            unsafe { std::ptr::write_volatile(&mut cell.glyph, '\0') };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl Screen {
    pub(super) fn update(&mut self, raw: &[u8], mut error_at_lf: impl FnMut(usize, &Self) -> bool) {
        while self.unsupported.is_none() && self.consumed < raw.len() {
            let offset = self.consumed;
            if raw[offset] == b'\n' && matches!(self.parser, Parser::Ground) && error_at_lf(offset, self) {
                // Check the row the LF ends, before that LF moves or scrolls it.
                self.verified_errors[self.cursor.row] = true;
            }
            let Some(length) = self.accept_byte(raw, offset) else { break; };
            self.consumed += length;
        }
    }

    pub(super) fn finish(&mut self, raw: &[u8], error_at_lf: impl FnMut(usize, &Self) -> bool) {
        self.update(raw, error_at_lf);
        if self.unsupported.is_some() { return; }
        // An unterminated OSC does not draw. OSC 133 and any incomplete
        // sequence that could affect cells cannot establish a final value.
        match self.parser {
            Parser::Osc { start, .. } if self.consumed == raw.len() => {
                if osc_133(&raw[start..]) {
                    self.unsupported = Some(ControlFamily::Osc133);
                } else {
                    self.parser = Parser::Ground;
                }
            }
            Parser::Ground if self.consumed == raw.len() => {}
            _ => self.unsupported = Some(ControlFamily::IncompleteSequence),
        }
    }

    pub(super) fn has_pending_escape(&self) -> bool {
        self.unsupported.is_none() && matches!(self.parser, Parser::Escape | Parser::Csi { .. })
    }

    pub(super) fn is_unsupported(&self) -> bool {
        self.unsupported.is_some()
    }

    pub(super) fn unsupported_control(&self) -> Option<ControlFamily> {
        self.unsupported
    }

    pub(super) fn lines(&self) -> Result<Vec<VisibleLine>, ScreenUncertainty> {
        // The parser writes cells only when a glyph or command is complete.
        if let Some(control) = self.unsupported {
            return Err(ScreenUncertainty::Unsupported(control));
        }
        if self.rows.contains(&RowQuality::Uncertain) {
            return Err(ScreenUncertainty::UncertainRow);
        }
        Ok(self.visible_lines().collect())
    }

    // Diagnostics count the modeled cells even when the screen is ineligible.
    pub(super) fn visible_lines(&self) -> impl Iterator<Item = VisibleLine> + '_ {
        (0..ROWS).map(|row| self.visible_line(row))
    }

    pub(super) fn cursor_line(&self) -> Option<VisibleLine> {
        let row = self.cursor.row;
        (!self.cursor.uncertain_row && self.rows[row] != RowQuality::Uncertain)
            .then(|| self.visible_line(row))
    }

    pub(super) fn has_verified_error(&self) -> bool {
        self.verified_errors.iter().zip(self.rows)
            .any(|(&error, quality)| error && quality != RowQuality::Uncertain)
    }

    fn row_cells(&self, row: usize) -> &[Cell] {
        &self.cells[row * COLS..(row + 1) * COLS]
    }

    fn visible_line(&self, row: usize) -> VisibleLine {
        let cells = self.row_cells(row);
        let edge = cells[COLS - 1];
        let edge_glyph = if edge.width == CellWidth::Continuation {
            cells[COLS - 2].glyph
        } else {
            edge.glyph
        };
        let used = cells.iter().rposition(|cell| cell.glyph != ' ').map_or(0, |i| i + 1);
        let mut text = SecretBytes(Vec::with_capacity(used * 4));
        for cell in &cells[..used] {
            if cell.width != CellWidth::Continuation {
                text.0.extend_from_slice(cell.glyph.encode_utf8(&mut [0; 4]).as_bytes());
            }
        }
        VisibleLine {
            text,
            ambiguous_width: self.rows[row] == RowQuality::AmbiguousWidth,
            right_edge_blank: edge_glyph.is_whitespace(),
        }
    }

    fn accept_byte(&mut self, raw: &[u8], offset: usize) -> Option<usize> {
        let byte = raw[offset];
        match self.parser {
            Parser::Ground => match byte {
                0 | 7 => {}
                b'\x1b' => self.parser = Parser::Escape,
                b'\r' => self.cursor.anchor_column(0),
                b'\n' => self.line_feed(),
                b'\x08' => self.cursor.move_column(|col| col.saturating_sub(1)),
                b'\t' => {
                    self.cursor.stop_appending();
                    let stop = |col: usize| ((col / 8 + 1) * 8).min(COLS - 1);
                    self.cursor.col = stop(self.cursor.col);
                    if let Some(drift) = &mut self.cursor.uncertain_col {
                        drift.furthest = stop(drift.furthest).max(drift.furthest);
                    }
                }
                0x00..=0x1f | 0x7f => self.unsupported = Some(ControlFamily::C0),
                0x80..=0x9f => self.unsupported = Some(ControlFamily::C1),
                _ => {
                    let (glyph, length) = glyph(&raw[offset..])?;
                    if ('\u{80}'..='\u{9f}').contains(&glyph) {
                        self.unsupported = Some(ControlFamily::C1);
                    } else {
                        self.put(glyph);
                    }
                    return Some(length);
                }
            },
            Parser::Escape => match byte {
                b'[' => self.parser = Parser::Csi { start: offset + 1 },
                b']' => self.parser = Parser::Osc { start: offset + 1, escape: false },
                _ => self.unsupported = Some(ControlFamily::Escape),
            },
            Parser::Csi { start } => match byte {
                0x30..=0x3f => {}
                0x40..=0x7e => {
                    self.parser = Parser::Ground;
                    self.csi(byte, &raw[start..offset]);
                }
                _ => self.unsupported = Some(ControlFamily::Csi),
            },
            Parser::Osc { start, escape } => match (escape, byte) {
                (true, b'\\') => self.end_osc(&raw[start..offset - 1]),
                (true, _) => self.unsupported = Some(ControlFamily::Osc),
                (false, 7) => self.end_osc(&raw[start..offset]),
                (false, b'\x1b') => {
                    self.unsupported = osc_133(&raw[start..offset]).then_some(ControlFamily::Osc133);
                    self.parser = Parser::Osc { start, escape: true };
                }
                (false, b';') if osc_133(&raw[start..offset]) => self.unsupported = Some(ControlFamily::Osc133),
                (false, 0x18 | 0x1a | 0x7f) => self.unsupported = Some(ControlFamily::C0),
                (false, 0x80..=0x9f) => self.unsupported = Some(ControlFamily::C1),
                (false, 0x00..=0x1f) => {}
                (false, 0xa0..=0xff) => {
                    let (glyph, length) = glyph(&raw[offset..])?;
                    if ('\u{80}'..='\u{9f}').contains(&glyph) {
                        self.unsupported = Some(ControlFamily::C1);
                    }
                    return Some(length);
                }
                (false, _) => {}
            },
        }
        Some(1)
    }

    fn end_osc(&mut self, body: &[u8]) {
        self.parser = Parser::Ground;
        self.unsupported = osc_133(body).then_some(ControlFamily::Osc133);
    }

    fn csi(&mut self, command: u8, params: &[u8]) {
        match (command, params) {
            (b't', b"1") | (b'c', b"") => return,
            (b'm', _) if params.iter().all(|byte| byte.is_ascii_digit() || matches!(*byte, b';' | b':')) => {
                self.sgr(params);
                return;
            }
            (b'h' | b'l', [b'?', modes @ ..]) => {
                for mode in modes.split(|byte| *byte == b';') {
                    match number(mode) {
                        Some(7) => self.autowrap = command == b'h',
                        Some(1 | 12 | 25 | 1004 | 1007 | 2004 | 2026 | 9001) => {}
                        Some(47 | 1047 | 1048 | 1049) => {
                            self.unsupported.get_or_insert(ControlFamily::AltScreen);
                        }
                        _ => {
                            self.unsupported.get_or_insert(ControlFamily::Csi);
                        }
                    }
                }
                return;
            }
            _ => {}
        }
        let mut fields = params.split(|byte| *byte == b';');
        let first = fields.next().and_then(number);
        let second = match fields.next() {
            None => Some(1),
            Some(field) if matches!(command, b'H' | b'f') && fields.next().is_none() => number(field),
            _ => None,
        };
        let unsupported = if command == b'r' { ControlFamily::CsiR } else { ControlFamily::Csi };
        let (Some(first), Some(second)) = (first, second) else {
            self.unsupported = Some(unsupported);
            return;
        };
        let count = first.max(1);
        match command {
            b'A'..=b'G' | b'H' | b'f' | b'd' | b'\x60' => self.position(command, count, second.max(1)),
            b'J' if first <= 3 => self.erase_display(first),
            b'K' if first <= 2 => self.erase_line(first),
            b'X' | b'P' | b'@' => self.edit_cells(command, count),
            b'L' | b'M' => {
                if self.cursor.uncertain_row {
                    self.uncertain_scroll(count, command == b'L');
                } else {
                    self.scroll(self.cursor.row, count, command == b'L');
                }
                self.cursor.move_column(|_| 0);
            }
            b'S' | b'T' => self.scroll(0, count, command == b'T'),
            _ => self.unsupported = Some(unsupported),
        }
    }

    fn sgr(&mut self, params: &[u8]) {
        let mut fields = params.split(|byte| *byte == b';');
        while let Some(field) = fields.next() {
            // Xterm accepts colon subparameters for colors. They do not
            // change concealment, including when added to an invalid rendition.
            if field.contains(&b':') {
                continue;
            }
            match number(field) {
                Some(0 | 28) => self.hidden = false,
                Some(8) => self.hidden = true,
                Some(38 | 48 | 58) => {
                    // RGB or palette data may contain the SGR codes 0, 8 and 28.
                    // A color mode with subparameters already includes its data.
                    match fields.next().and_then(number) {
                        Some(2) => { fields.nth(2); }
                        Some(5) => { fields.next(); }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    fn position(&mut self, command: u8, count: usize, column: usize) {
        self.cursor.end_wrap();
        self.cursor.stop_appending();
        match command {
            b'H' | b'f' => {
                self.cursor.row = count.min(ROWS) - 1;
                self.cursor.uncertain_row = false;
                self.cursor.anchor_column(column.min(COLS) - 1);
            }
            b'd' => {
                self.cursor.row = count.min(ROWS) - 1;
                self.cursor.uncertain_row = false;
            }
            b'G' | b'\x60' => self.cursor.anchor_column(count.min(COLS) - 1),
            b'A' | b'F' => self.cursor.row = self.cursor.row.saturating_sub(count),
            b'B' | b'E' => self.cursor.row = self.cursor.row.saturating_add(count).min(ROWS - 1),
            b'C' => self.cursor.move_column(|col| col.saturating_add(count).min(COLS - 1)),
            b'D' => self.cursor.move_column(|col| col.saturating_sub(count)),
            _ => unreachable!(),
        }
        if matches!(command, b'E' | b'F') {
            self.cursor.anchor_column(0);
        }
    }

    fn line_feed(&mut self) {
        self.cursor.end_wrap();
        self.cursor.stop_appending();
        if self.cursor.uncertain_row {
            // An earlier ambiguous wrap can change whether this LF scrolls.
            self.uncertain_scroll(1, false);
        } else if self.cursor.row == ROWS - 1 {
            self.scroll(0, 1, false);
        } else {
            self.cursor.row += 1;
        }
    }

    fn uncertain_scroll(&mut self, count: usize, down: bool) {
        let blank: [bool; ROWS] = std::array::from_fn(|row| {
            self.rows[row] == RowQuality::Exact && self.row_cells(row).iter()
                .all(|cell| cell.glyph == ' ' && cell.width == CellWidth::Single)
        });
        for (row, quality) in self.rows.iter_mut().enumerate() {
            // A row is still blank if neither retaining it nor shifting a row
            // into it can introduce content.
            let source = if down { row.checked_sub(count) } else { row.checked_add(count) };
            if !blank[row] || source.and_then(|index| blank.get(index)).is_some_and(|&was_blank| !was_blank) {
                *quality = RowQuality::Uncertain;
            }
        }
    }

    fn scroll(&mut self, first: usize, count: usize, down: bool) {
        let count = count.min(ROWS - first);
        if down {
            self.rows.copy_within(first..ROWS - count, first + count);
            self.verified_errors.copy_within(first..ROWS - count, first + count);
            self.cells.copy_within(first * COLS..(ROWS - count) * COLS, (first + count) * COLS);
            self.clear_rows(first..first + count);
        } else {
            self.rows.copy_within(first + count..ROWS, first);
            self.verified_errors.copy_within(first + count..ROWS, first);
            self.cells.copy_within((first + count) * COLS..ROWS * COLS, first * COLS);
            self.clear_rows(ROWS - count..ROWS);
        }
        self.cursor.stop_appending();
    }

    fn put(&mut self, glyph: char) {
        let width = glyph_width(glyph);
        let cells = if width == GlyphWidth::Wide { 2 } else { 1 };
        let variable = width == GlyphWidth::Uncertain;
        let uncertain_col = self.cursor.uncertain_col;
        let max_start = uncertain_col.map_or(
            if self.autowrap && self.cursor.wrap_pending { COLS } else { self.cursor.col },
            |drift| drift.furthest,
        );
        let max_end = max_start + if variable { 2 } else { cells };
        if self.cursor.uncertain_row {
            self.rows.fill(RowQuality::Uncertain);
            return;
        }
        if self.autowrap && (variable || uncertain_col.is_some()) && max_end > COLS {
            // The glyph may begin or combine on either side of the margin.
            // At the bottom this can move every row in the viewport.
            let row = self.cursor.row;
            if row + 1 == ROWS {
                self.rows.fill(RowQuality::Uncertain);
            } else {
                self.rows[row..=row + 1].fill(RowQuality::Uncertain);
            }
            self.cursor.uncertain_row = true;
            self.cursor.uncertain_col = Some(UncertainColumn { furthest: COLS, appending: false });
            return;
        }
        if self.autowrap && (self.cursor.wrap_pending || self.cursor.col + cells > COLS) {
            self.line_feed();
            self.cursor.anchor_column(0);
        } else if self.cursor.col + cells > COLS {
            // A wide glyph cannot be drawn in one remaining cell.
            self.cursor.wrap_pending = false;
            return;
        }

        let row = self.cursor.row;
        let col = self.cursor.col;
        self.verified_errors[row] = false;
        match (self.rows[row], uncertain_col) {
            (RowQuality::Exact, None) if variable => self.rows[row] = RowQuality::AmbiguousWidth,
            (RowQuality::Exact, None) | (RowQuality::AmbiguousWidth, Some(UncertainColumn { appending: true, .. })) => {}
            _ => self.rows[row] = RowQuality::Uncertain,
        }
        let line = &mut self.cells[row * COLS..(row + 1) * COLS];
        Self::erase_span(line, col..col + cells);
        line[col] = Cell {
            glyph: if self.hidden { ' ' } else { glyph },
            width: if cells == 2 { CellWidth::Wide } else { CellWidth::Single },
        };
        if cells == 2 {
            line[col + 1] = Cell::CONTINUATION;
        }
        self.cursor.col = (col + cells).min(COLS - 1);
        // XTerm records the margin hit even while DECAWM is disabled.
        self.cursor.wrap_pending = col + cells == COLS;
        if variable || uncertain_col.is_some() {
            self.cursor.uncertain_col = Some(UncertainColumn {
                furthest: max_end.min(COLS),
                appending: self.rows[row] == RowQuality::AmbiguousWidth,
            });
        }
    }

    fn clear_rows(&mut self, rows: Range<usize>) {
        self.cells[rows.start * COLS..rows.end * COLS].fill(Cell::BLANK);
        self.verified_errors[rows.clone()].fill(false);
        self.rows[rows].fill(RowQuality::Exact);
    }

    fn erase_span(line: &mut [Cell], cols: Range<usize>) {
        let start = cols.start - usize::from(line[cols.start].width == CellWidth::Continuation);
        let end = cols.end + usize::from(line[cols.end - 1].width == CellWidth::Wide);
        line[start..end].fill(Cell::BLANK);
    }

    fn partial_edit_row(&mut self) -> Option<&mut [Cell]> {
        self.cursor.end_wrap();
        self.cursor.stop_appending();
        let row = self.cursor.row;
        if self.cursor.uncertain_row {
            self.rows.fill(RowQuality::Uncertain);
            return None;
        }
        self.verified_errors[row] = false;
        if self.cursor.uncertain_col.is_some() || self.rows[row] != RowQuality::Exact {
            self.rows[row] = RowQuality::Uncertain;
            return None;
        }
        Some(&mut self.cells[row * COLS..(row + 1) * COLS])
    }

    fn erase_line(&mut self, mode: usize) {
        let col = self.cursor.col;
        let row = self.cursor.row;
        let all = mode == 2 || (self.cursor.uncertain_col.is_none()
            && ((mode == 0 && col == 0) || (mode == 1 && col == COLS - 1)));
        if all {
            self.cursor.end_wrap();
            self.cursor.stop_appending();
            if self.cursor.uncertain_row {
                self.rows.fill(RowQuality::Uncertain);
            } else {
                self.clear_rows(row..row + 1);
            }
        } else if let Some(line) = self.partial_edit_row() {
            let cols = if mode == 0 { col..COLS } else { 0..col + 1 };
            Self::erase_span(line, cols);
        }
    }

    fn erase_display(&mut self, mode: usize) {
        let row = self.cursor.row;
        match mode {
            2 => {
                self.cursor.end_wrap();
                self.cursor.stop_appending();
                self.clear_rows(0..ROWS);
            }
            3 => {} // ED 3 erases saved lines outside these cells.
            0 | 1 if self.cursor.uncertain_row => self.rows.fill(RowQuality::Uncertain),
            0 => {
                self.erase_line(0);
                self.clear_rows(row + 1..ROWS);
            }
            1 => {
                self.clear_rows(0..row);
                self.erase_line(1);
            }
            _ => unreachable!(),
        }
    }

    fn edit_cells(&mut self, command: u8, count: usize) {
        let col = self.cursor.col;
        let count = count.min(COLS - col);
        if command == b'X' && count == COLS && self.cursor.uncertain_col.is_none() {
            self.erase_line(2);
            return;
        }
        let Some(line) = self.partial_edit_row() else { return; };
        if command == b'X' {
            Self::erase_span(line, col..col + count);
            return;
        }
        // Erase a glyph if a cut would separate its two cells.
        let repair = |line: &mut [Cell], cut: usize| {
            if cut < COLS && line[cut].width == CellWidth::Continuation {
                line[cut - 1..=cut].fill(Cell::BLANK);
            }
        };
        repair(line, col);
        if command == b'P' {
            repair(line, col + count);
            line.copy_within(col + count.., col);
            line[COLS - count..].fill(Cell::BLANK);
        } else {
            repair(line, COLS - count);
            line.copy_within(col..COLS - count, col + count);
            line[col..col + count].fill(Cell::BLANK);
        }
    }
}

fn osc_133(body: &[u8]) -> bool {
    let number = body.iter().copied().take_while(|byte| *byte != b';').filter(|byte| *byte != 0);
    decimal(number) == Some(133)
}

fn number(field: &[u8]) -> Option<usize> {
    decimal(field.iter().copied())
}

fn decimal(mut digits: impl Iterator<Item = u8>) -> Option<usize> {
    digits.try_fold(0usize, |value, byte| {
        byte.is_ascii_digit().then(|| value.saturating_mul(10).saturating_add(usize::from(byte - b'0')))
    })
}

fn glyph(bytes: &[u8]) -> Option<(char, usize)> {
    let length = match bytes[0] {
        0x20..=0x7e => return Some((char::from(bytes[0]), 1)),
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Some(('\0', 1)),
    };
    let prefix = &bytes[..bytes.len().min(length)];
    match std::str::from_utf8(prefix) {
        Ok(text) => Some((text.chars().next()?, length)),
        Err(error) => error.error_len().map(|length| ('\0', length)),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GlyphWidth {
    Single,
    Wide,
    Uncertain,
}

fn glyph_width(glyph: char) -> GlyphWidth {
    fn contains(ranges: &[(u32, u32)], code: u32) -> bool {
        ranges.get(ranges.partition_point(|&(_, end)| end < code))
            .is_some_and(|&(start, _)| start <= code)
    }
    let code = u32::from(glyph);
    if glyph == '\0' {
        GlyphWidth::Uncertain
    } else if glyph.is_ascii() {
        GlyphWidth::Single
    } else if contains(UNCERTAIN, code) {
        GlyphWidth::Uncertain
    } else if contains(WIDE, code) {
        GlyphWidth::Wide
    } else {
        GlyphWidth::Single
    }
}

// Generated with Python 3.12.10 unicodedata (Unicode 15.0.0).
// Unassigned scalars and characters with variable cell width take precedence
// over East_Asian_Width W/F. The generator is in tmp/0915-2/.
#[rustfmt::skip]
const UNCERTAIN: &[(u32, u32)] = &[
    (0x0080, 0x009f), (0x00a1, 0x00a1), (0x00a4, 0x00a4), (0x00a7, 0x00a8),
    (0x00aa, 0x00aa), (0x00ad, 0x00ae), (0x00b0, 0x00b4), (0x00b6, 0x00ba),
    (0x00bc, 0x00bf), (0x00c6, 0x00c6), (0x00d0, 0x00d0), (0x00d7, 0x00d8),
    (0x00de, 0x00e1), (0x00e6, 0x00e6), (0x00e8, 0x00ea), (0x00ec, 0x00ed),
    (0x00f0, 0x00f0), (0x00f2, 0x00f3), (0x00f7, 0x00fa), (0x00fc, 0x00fc),
    (0x00fe, 0x00fe), (0x0101, 0x0101), (0x0111, 0x0111), (0x0113, 0x0113),
    (0x011b, 0x011b), (0x0126, 0x0127), (0x012b, 0x012b), (0x0131, 0x0133),
    (0x0138, 0x0138), (0x013f, 0x0142), (0x0144, 0x0144), (0x0148, 0x014b),
    (0x014d, 0x014d), (0x0152, 0x0153), (0x0166, 0x0167), (0x016b, 0x016b),
    (0x01ce, 0x01ce), (0x01d0, 0x01d0), (0x01d2, 0x01d2), (0x01d4, 0x01d4),
    (0x01d6, 0x01d6), (0x01d8, 0x01d8), (0x01da, 0x01da), (0x01dc, 0x01dc),
    (0x0251, 0x0251), (0x0261, 0x0261), (0x02c4, 0x02c4), (0x02c7, 0x02c7),
    (0x02c9, 0x02cb), (0x02cd, 0x02cd), (0x02d0, 0x02d0), (0x02d8, 0x02db),
    (0x02dd, 0x02dd), (0x02df, 0x02df), (0x0300, 0x036f), (0x0378, 0x0379),
    (0x0380, 0x0383), (0x038b, 0x038b), (0x038d, 0x038d), (0x0391, 0x03a9),
    (0x03b1, 0x03c1), (0x03c3, 0x03c9), (0x0401, 0x0401), (0x0410, 0x044f),
    (0x0451, 0x0451), (0x0483, 0x0489), (0x0530, 0x0530), (0x0557, 0x0558),
    (0x058b, 0x058c), (0x0590, 0x05bd), (0x05bf, 0x05bf), (0x05c1, 0x05c2),
    (0x05c4, 0x05c5), (0x05c7, 0x05cf), (0x05eb, 0x05ee), (0x05f5, 0x0605),
    (0x0610, 0x061a), (0x061c, 0x061c), (0x064b, 0x065f), (0x0670, 0x0670),
    (0x06d6, 0x06dd), (0x06df, 0x06e4), (0x06e7, 0x06e8), (0x06ea, 0x06ed),
    (0x070e, 0x070f), (0x0711, 0x0711), (0x0730, 0x074c), (0x07a6, 0x07b0),
    (0x07b2, 0x07bf), (0x07eb, 0x07f3), (0x07fb, 0x07fd), (0x0816, 0x0819),
    (0x081b, 0x0823), (0x0825, 0x0827), (0x0829, 0x082f), (0x083f, 0x083f),
    (0x0859, 0x085d), (0x085f, 0x085f), (0x086b, 0x086f), (0x088f, 0x089f),
    (0x08ca, 0x0903), (0x093a, 0x093c), (0x093e, 0x094f), (0x0951, 0x0957),
    (0x0962, 0x0963), (0x0981, 0x0984), (0x098d, 0x098e), (0x0991, 0x0992),
    (0x09a9, 0x09a9), (0x09b1, 0x09b1), (0x09b3, 0x09b5), (0x09ba, 0x09bc),
    (0x09be, 0x09cd), (0x09cf, 0x09db), (0x09de, 0x09de), (0x09e2, 0x09e5),
    (0x09fe, 0x0a04), (0x0a0b, 0x0a0e), (0x0a11, 0x0a12), (0x0a29, 0x0a29),
    (0x0a31, 0x0a31), (0x0a34, 0x0a34), (0x0a37, 0x0a37), (0x0a3a, 0x0a58),
    (0x0a5d, 0x0a5d), (0x0a5f, 0x0a65), (0x0a70, 0x0a71), (0x0a75, 0x0a75),
    (0x0a77, 0x0a84), (0x0a8e, 0x0a8e), (0x0a92, 0x0a92), (0x0aa9, 0x0aa9),
    (0x0ab1, 0x0ab1), (0x0ab4, 0x0ab4), (0x0aba, 0x0abc), (0x0abe, 0x0acf),
    (0x0ad1, 0x0adf), (0x0ae2, 0x0ae5), (0x0af2, 0x0af8), (0x0afa, 0x0b04),
    (0x0b0d, 0x0b0e), (0x0b11, 0x0b12), (0x0b29, 0x0b29), (0x0b31, 0x0b31),
    (0x0b34, 0x0b34), (0x0b3a, 0x0b3c), (0x0b3e, 0x0b5b), (0x0b5e, 0x0b5e),
    (0x0b62, 0x0b65), (0x0b78, 0x0b82), (0x0b84, 0x0b84), (0x0b8b, 0x0b8d),
    (0x0b91, 0x0b91), (0x0b96, 0x0b98), (0x0b9b, 0x0b9b), (0x0b9d, 0x0b9d),
    (0x0ba0, 0x0ba2), (0x0ba5, 0x0ba7), (0x0bab, 0x0bad), (0x0bba, 0x0bcf),
    (0x0bd1, 0x0be5), (0x0bfb, 0x0c04), (0x0c0d, 0x0c0d), (0x0c11, 0x0c11),
    (0x0c29, 0x0c29), (0x0c3a, 0x0c3c), (0x0c3e, 0x0c57), (0x0c5b, 0x0c5c),
    (0x0c5e, 0x0c5f), (0x0c62, 0x0c65), (0x0c70, 0x0c76), (0x0c81, 0x0c83),
    (0x0c8d, 0x0c8d), (0x0c91, 0x0c91), (0x0ca9, 0x0ca9), (0x0cb4, 0x0cb4),
    (0x0cba, 0x0cbc), (0x0cbe, 0x0cdc), (0x0cdf, 0x0cdf), (0x0ce2, 0x0ce5),
    (0x0cf0, 0x0cf0), (0x0cf3, 0x0d03), (0x0d0d, 0x0d0d), (0x0d11, 0x0d11),
    (0x0d3b, 0x0d3c), (0x0d3e, 0x0d4d), (0x0d50, 0x0d53), (0x0d57, 0x0d57),
    (0x0d62, 0x0d65), (0x0d80, 0x0d84), (0x0d97, 0x0d99), (0x0db2, 0x0db2),
    (0x0dbc, 0x0dbc), (0x0dbe, 0x0dbf), (0x0dc7, 0x0de5), (0x0df0, 0x0df3),
    (0x0df5, 0x0e00), (0x0e31, 0x0e31), (0x0e34, 0x0e3e), (0x0e47, 0x0e4e),
    (0x0e5c, 0x0e80), (0x0e83, 0x0e83), (0x0e85, 0x0e85), (0x0e8b, 0x0e8b),
    (0x0ea4, 0x0ea4), (0x0ea6, 0x0ea6), (0x0eb1, 0x0eb1), (0x0eb4, 0x0ebc),
    (0x0ebe, 0x0ebf), (0x0ec5, 0x0ec5), (0x0ec7, 0x0ecf), (0x0eda, 0x0edb),
    (0x0ee0, 0x0eff), (0x0f18, 0x0f19), (0x0f35, 0x0f35), (0x0f37, 0x0f37),
    (0x0f39, 0x0f39), (0x0f3e, 0x0f3f), (0x0f48, 0x0f48), (0x0f6d, 0x0f84),
    (0x0f86, 0x0f87), (0x0f8d, 0x0fbd), (0x0fc6, 0x0fc6), (0x0fcd, 0x0fcd),
    (0x0fdb, 0x0fff), (0x102b, 0x103e), (0x1056, 0x1059), (0x105e, 0x1060),
    (0x1062, 0x1064), (0x1067, 0x106d), (0x1071, 0x1074), (0x1082, 0x108d),
    (0x108f, 0x108f), (0x109a, 0x109d), (0x10c6, 0x10c6), (0x10c8, 0x10cc),
    (0x10ce, 0x10cf), (0x1160, 0x11ff), (0x1249, 0x1249), (0x124e, 0x124f),
    (0x1257, 0x1257), (0x1259, 0x1259), (0x125e, 0x125f), (0x1289, 0x1289),
    (0x128e, 0x128f), (0x12b1, 0x12b1), (0x12b6, 0x12b7), (0x12bf, 0x12bf),
    (0x12c1, 0x12c1), (0x12c6, 0x12c7), (0x12d7, 0x12d7), (0x1311, 0x1311),
    (0x1316, 0x1317), (0x135b, 0x135f), (0x137d, 0x137f), (0x139a, 0x139f),
    (0x13f6, 0x13f7), (0x13fe, 0x13ff), (0x169d, 0x169f), (0x16f9, 0x16ff),
    (0x1712, 0x171e), (0x1732, 0x1734), (0x1737, 0x173f), (0x1752, 0x175f),
    (0x176d, 0x176d), (0x1771, 0x177f), (0x17b4, 0x17d3), (0x17dd, 0x17df),
    (0x17ea, 0x17ef), (0x17fa, 0x17ff), (0x180b, 0x180f), (0x181a, 0x181f),
    (0x1879, 0x187f), (0x1885, 0x1886), (0x18a9, 0x18a9), (0x18ab, 0x18af),
    (0x18f6, 0x18ff), (0x191f, 0x193f), (0x1941, 0x1943), (0x196e, 0x196f),
    (0x1975, 0x197f), (0x19ac, 0x19af), (0x19ca, 0x19cf), (0x19db, 0x19dd),
    (0x1a17, 0x1a1d), (0x1a55, 0x1a7f), (0x1a8a, 0x1a8f), (0x1a9a, 0x1a9f),
    (0x1aae, 0x1b04), (0x1b34, 0x1b44), (0x1b4d, 0x1b4f), (0x1b6b, 0x1b73),
    (0x1b7f, 0x1b82), (0x1ba1, 0x1bad), (0x1be6, 0x1bfb), (0x1c24, 0x1c3a),
    (0x1c4a, 0x1c4c), (0x1c89, 0x1c8f), (0x1cbb, 0x1cbc), (0x1cc8, 0x1cd2),
    (0x1cd4, 0x1ce8), (0x1ced, 0x1ced), (0x1cf4, 0x1cf4), (0x1cf7, 0x1cf9),
    (0x1cfb, 0x1cff), (0x1dc0, 0x1dff), (0x1f16, 0x1f17), (0x1f1e, 0x1f1f),
    (0x1f46, 0x1f47), (0x1f4e, 0x1f4f), (0x1f58, 0x1f58), (0x1f5a, 0x1f5a),
    (0x1f5c, 0x1f5c), (0x1f5e, 0x1f5e), (0x1f7e, 0x1f7f), (0x1fb5, 0x1fb5),
    (0x1fc5, 0x1fc5), (0x1fd4, 0x1fd5), (0x1fdc, 0x1fdc), (0x1ff0, 0x1ff1),
    (0x1ff5, 0x1ff5), (0x1fff, 0x1fff), (0x200b, 0x2010), (0x2013, 0x2016),
    (0x2018, 0x2019), (0x201c, 0x201d), (0x2020, 0x2022), (0x2024, 0x2027),
    (0x202a, 0x202e), (0x2030, 0x2030), (0x2032, 0x2033), (0x2035, 0x2035),
    (0x203b, 0x203b), (0x203e, 0x203e), (0x2060, 0x206f), (0x2072, 0x2074),
    (0x207f, 0x207f), (0x2081, 0x2084), (0x208f, 0x208f), (0x209d, 0x209f),
    (0x20ac, 0x20ac), (0x20c1, 0x20ff), (0x2103, 0x2103), (0x2105, 0x2105),
    (0x2109, 0x2109), (0x2113, 0x2113), (0x2116, 0x2116), (0x2121, 0x2122),
    (0x2126, 0x2126), (0x212b, 0x212b), (0x2153, 0x2154), (0x215b, 0x215e),
    (0x2160, 0x216b), (0x2170, 0x2179), (0x2189, 0x2189), (0x218c, 0x2199),
    (0x21b8, 0x21b9), (0x21d2, 0x21d2), (0x21d4, 0x21d4), (0x21e7, 0x21e7),
    (0x2200, 0x2200), (0x2202, 0x2203), (0x2207, 0x2208), (0x220b, 0x220b),
    (0x220f, 0x220f), (0x2211, 0x2211), (0x2215, 0x2215), (0x221a, 0x221a),
    (0x221d, 0x2220), (0x2223, 0x2223), (0x2225, 0x2225), (0x2227, 0x222c),
    (0x222e, 0x222e), (0x2234, 0x2237), (0x223c, 0x223d), (0x2248, 0x2248),
    (0x224c, 0x224c), (0x2252, 0x2252), (0x2260, 0x2261), (0x2264, 0x2267),
    (0x226a, 0x226b), (0x226e, 0x226f), (0x2282, 0x2283), (0x2286, 0x2287),
    (0x2295, 0x2295), (0x2299, 0x2299), (0x22a5, 0x22a5), (0x22bf, 0x22bf),
    (0x2312, 0x2312), (0x2427, 0x243f), (0x244b, 0x24e9), (0x24eb, 0x254b),
    (0x2550, 0x2573), (0x2580, 0x258f), (0x2592, 0x2595), (0x25a0, 0x25a1),
    (0x25a3, 0x25a9), (0x25b2, 0x25b3), (0x25b6, 0x25b7), (0x25bc, 0x25bd),
    (0x25c0, 0x25c1), (0x25c6, 0x25c8), (0x25cb, 0x25cb), (0x25ce, 0x25d1),
    (0x25e2, 0x25e5), (0x25ef, 0x25ef), (0x2605, 0x2606), (0x2609, 0x2609),
    (0x260e, 0x260f), (0x261c, 0x261c), (0x261e, 0x261e), (0x2640, 0x2640),
    (0x2642, 0x2642), (0x2660, 0x2661), (0x2663, 0x2665), (0x2667, 0x266a),
    (0x266c, 0x266d), (0x266f, 0x266f), (0x269e, 0x269f), (0x26bf, 0x26bf),
    (0x26c6, 0x26cd), (0x26cf, 0x26d3), (0x26d5, 0x26e1), (0x26e3, 0x26e3),
    (0x26e8, 0x26e9), (0x26eb, 0x26f1), (0x26f4, 0x26f4), (0x26f6, 0x26f9),
    (0x26fb, 0x26fc), (0x26fe, 0x26ff), (0x273d, 0x273d), (0x2776, 0x277f),
    (0x2b56, 0x2b59), (0x2b74, 0x2b75), (0x2b96, 0x2b96), (0x2cef, 0x2cf1),
    (0x2cf4, 0x2cf8), (0x2d26, 0x2d26), (0x2d28, 0x2d2c), (0x2d2e, 0x2d2f),
    (0x2d68, 0x2d6e), (0x2d71, 0x2d7f), (0x2d97, 0x2d9f), (0x2da7, 0x2da7),
    (0x2daf, 0x2daf), (0x2db7, 0x2db7), (0x2dbf, 0x2dbf), (0x2dc7, 0x2dc7),
    (0x2dcf, 0x2dcf), (0x2dd7, 0x2dd7), (0x2ddf, 0x2dff), (0x2e5e, 0x2e7f),
    (0x2e9a, 0x2e9a), (0x2ef4, 0x2eff), (0x2fd6, 0x2fef), (0x2ffc, 0x2fff),
    (0x302a, 0x302f), (0x3040, 0x3040), (0x3097, 0x309a), (0x3100, 0x3104),
    (0x3130, 0x3130), (0x318f, 0x318f), (0x31e4, 0x31ef), (0x321f, 0x321f),
    (0x3248, 0x324f), (0xa48d, 0xa48f), (0xa4c7, 0xa4cf), (0xa62c, 0xa63f),
    (0xa66f, 0xa672), (0xa674, 0xa67d), (0xa69e, 0xa69f), (0xa6f0, 0xa6f1),
    (0xa6f8, 0xa6ff), (0xa7cb, 0xa7cf), (0xa7d2, 0xa7d2), (0xa7d4, 0xa7d4),
    (0xa7da, 0xa7f1), (0xa802, 0xa802), (0xa806, 0xa806), (0xa80b, 0xa80b),
    (0xa823, 0xa827), (0xa82c, 0xa82f), (0xa83a, 0xa83f), (0xa878, 0xa881),
    (0xa8b4, 0xa8cd), (0xa8da, 0xa8f1), (0xa8ff, 0xa8ff), (0xa926, 0xa92d),
    (0xa947, 0xa95e), (0xa97d, 0xa983), (0xa9b3, 0xa9c0), (0xa9ce, 0xa9ce),
    (0xa9da, 0xa9dd), (0xa9e5, 0xa9e5), (0xa9ff, 0xa9ff), (0xaa29, 0xaa3f),
    (0xaa43, 0xaa43), (0xaa4c, 0xaa4f), (0xaa5a, 0xaa5b), (0xaa7b, 0xaa7d),
    (0xaab0, 0xaab0), (0xaab2, 0xaab4), (0xaab7, 0xaab8), (0xaabe, 0xaabf),
    (0xaac1, 0xaac1), (0xaac3, 0xaada), (0xaaeb, 0xaaef), (0xaaf5, 0xab00),
    (0xab07, 0xab08), (0xab0f, 0xab10), (0xab17, 0xab1f), (0xab27, 0xab27),
    (0xab2f, 0xab2f), (0xab6c, 0xab6f), (0xabe3, 0xabea), (0xabec, 0xabef),
    (0xabfa, 0xabff), (0xd7a4, 0xd7ff), (0xe000, 0xf8ff), (0xfa6e, 0xfa6f),
    (0xfada, 0xfaff), (0xfb07, 0xfb12), (0xfb18, 0xfb1c), (0xfb1e, 0xfb1e),
    (0xfb37, 0xfb37), (0xfb3d, 0xfb3d), (0xfb3f, 0xfb3f), (0xfb42, 0xfb42),
    (0xfb45, 0xfb45), (0xfbc3, 0xfbd2), (0xfd90, 0xfd91), (0xfdc8, 0xfdce),
    (0xfdd0, 0xfdef), (0xfe00, 0xfe0f), (0xfe1a, 0xfe2f), (0xfe53, 0xfe53),
    (0xfe67, 0xfe67), (0xfe6c, 0xfe6f), (0xfe75, 0xfe75), (0xfefd, 0xff00),
    (0xffbf, 0xffc1), (0xffc8, 0xffc9), (0xffd0, 0xffd1), (0xffd8, 0xffd9),
    (0xffdd, 0xffdf), (0xffe7, 0xffe7), (0xffef, 0xfffb), (0xfffd, 0xffff),
    (0x1000c, 0x1000c), (0x10027, 0x10027), (0x1003b, 0x1003b), (0x1003e, 0x1003e),
    (0x1004e, 0x1004f), (0x1005e, 0x1007f), (0x100fb, 0x100ff), (0x10103, 0x10106),
    (0x10134, 0x10136), (0x1018f, 0x1018f), (0x1019d, 0x1019f), (0x101a1, 0x101cf),
    (0x101fd, 0x1027f), (0x1029d, 0x1029f), (0x102d1, 0x102e0), (0x102fc, 0x102ff),
    (0x10324, 0x1032c), (0x1034b, 0x1034f), (0x10376, 0x1037f), (0x1039e, 0x1039e),
    (0x103c4, 0x103c7), (0x103d6, 0x103ff), (0x1049e, 0x1049f), (0x104aa, 0x104af),
    (0x104d4, 0x104d7), (0x104fc, 0x104ff), (0x10528, 0x1052f), (0x10564, 0x1056e),
    (0x1057b, 0x1057b), (0x1058b, 0x1058b), (0x10593, 0x10593), (0x10596, 0x10596),
    (0x105a2, 0x105a2), (0x105b2, 0x105b2), (0x105ba, 0x105ba), (0x105bd, 0x105ff),
    (0x10737, 0x1073f), (0x10756, 0x1075f), (0x10768, 0x1077f), (0x10786, 0x10786),
    (0x107b1, 0x107b1), (0x107bb, 0x107ff), (0x10806, 0x10807), (0x10809, 0x10809),
    (0x10836, 0x10836), (0x10839, 0x1083b), (0x1083d, 0x1083e), (0x10856, 0x10856),
    (0x1089f, 0x108a6), (0x108b0, 0x108df), (0x108f3, 0x108f3), (0x108f6, 0x108fa),
    (0x1091c, 0x1091e), (0x1093a, 0x1093e), (0x10940, 0x1097f), (0x109b8, 0x109bb),
    (0x109d0, 0x109d1), (0x10a01, 0x10a0f), (0x10a14, 0x10a14), (0x10a18, 0x10a18),
    (0x10a36, 0x10a3f), (0x10a49, 0x10a4f), (0x10a59, 0x10a5f), (0x10aa0, 0x10abf),
    (0x10ae5, 0x10aea), (0x10af7, 0x10aff), (0x10b36, 0x10b38), (0x10b56, 0x10b57),
    (0x10b73, 0x10b77), (0x10b92, 0x10b98), (0x10b9d, 0x10ba8), (0x10bb0, 0x10bff),
    (0x10c49, 0x10c7f), (0x10cb3, 0x10cbf), (0x10cf3, 0x10cf9), (0x10d24, 0x10d2f),
    (0x10d3a, 0x10e5f), (0x10e7f, 0x10e7f), (0x10eaa, 0x10eac), (0x10eae, 0x10eaf),
    (0x10eb2, 0x10eff), (0x10f28, 0x10f2f), (0x10f46, 0x10f50), (0x10f5a, 0x10f6f),
    (0x10f82, 0x10f85), (0x10f8a, 0x10faf), (0x10fcc, 0x10fdf), (0x10ff7, 0x11002),
    (0x11038, 0x11046), (0x1104e, 0x11051), (0x11070, 0x11070), (0x11073, 0x11074),
    (0x11076, 0x11082), (0x110b0, 0x110ba), (0x110bd, 0x110bd), (0x110c2, 0x110cf),
    (0x110e9, 0x110ef), (0x110fa, 0x11102), (0x11127, 0x11135), (0x11145, 0x11146),
    (0x11148, 0x1114f), (0x11173, 0x11173), (0x11177, 0x11182), (0x111b3, 0x111c0),
    (0x111c9, 0x111cc), (0x111ce, 0x111cf), (0x111e0, 0x111e0), (0x111f5, 0x111ff),
    (0x11212, 0x11212), (0x1122c, 0x11237), (0x1123e, 0x1123e), (0x11241, 0x1127f),
    (0x11287, 0x11287), (0x11289, 0x11289), (0x1128e, 0x1128e), (0x1129e, 0x1129e),
    (0x112aa, 0x112af), (0x112df, 0x112ef), (0x112fa, 0x11304), (0x1130d, 0x1130e),
    (0x11311, 0x11312), (0x11329, 0x11329), (0x11331, 0x11331), (0x11334, 0x11334),
    (0x1133a, 0x1133c), (0x1133e, 0x1134f), (0x11351, 0x1135c), (0x11362, 0x113ff),
    (0x11435, 0x11446), (0x1145c, 0x1145c), (0x1145e, 0x1145e), (0x11462, 0x1147f),
    (0x114b0, 0x114c3), (0x114c8, 0x114cf), (0x114da, 0x1157f), (0x115af, 0x115c0),
    (0x115dc, 0x115ff), (0x11630, 0x11640), (0x11645, 0x1164f), (0x1165a, 0x1165f),
    (0x1166d, 0x1167f), (0x116ab, 0x116b7), (0x116ba, 0x116bf), (0x116ca, 0x116ff),
    (0x1171b, 0x1172f), (0x11747, 0x117ff), (0x1182c, 0x1183a), (0x1183c, 0x1189f),
    (0x118f3, 0x118fe), (0x11907, 0x11908), (0x1190a, 0x1190b), (0x11914, 0x11914),
    (0x11917, 0x11917), (0x11930, 0x1193e), (0x11940, 0x11940), (0x11942, 0x11943),
    (0x11947, 0x1194f), (0x1195a, 0x1199f), (0x119a8, 0x119a9), (0x119d1, 0x119e0),
    (0x119e4, 0x119ff), (0x11a01, 0x11a0a), (0x11a33, 0x11a39), (0x11a3b, 0x11a3e),
    (0x11a47, 0x11a4f), (0x11a51, 0x11a5b), (0x11a8a, 0x11a99), (0x11aa3, 0x11aaf),
    (0x11af9, 0x11aff), (0x11b0a, 0x11bff), (0x11c09, 0x11c09), (0x11c2f, 0x11c3f),
    (0x11c46, 0x11c4f), (0x11c6d, 0x11c6f), (0x11c90, 0x11cff), (0x11d07, 0x11d07),
    (0x11d0a, 0x11d0a), (0x11d31, 0x11d45), (0x11d47, 0x11d4f), (0x11d5a, 0x11d5f),
    (0x11d66, 0x11d66), (0x11d69, 0x11d69), (0x11d8a, 0x11d97), (0x11d99, 0x11d9f),
    (0x11daa, 0x11edf), (0x11ef3, 0x11ef6), (0x11ef9, 0x11f01), (0x11f03, 0x11f03),
    (0x11f11, 0x11f11), (0x11f34, 0x11f42), (0x11f5a, 0x11faf), (0x11fb1, 0x11fbf),
    (0x11ff2, 0x11ffe), (0x1239a, 0x123ff), (0x1246f, 0x1246f), (0x12475, 0x1247f),
    (0x12544, 0x12f8f), (0x12ff3, 0x12fff), (0x13430, 0x13440), (0x13447, 0x143ff),
    (0x14647, 0x167ff), (0x16a39, 0x16a3f), (0x16a5f, 0x16a5f), (0x16a6a, 0x16a6d),
    (0x16abf, 0x16abf), (0x16aca, 0x16acf), (0x16aee, 0x16af4), (0x16af6, 0x16aff),
    (0x16b30, 0x16b36), (0x16b46, 0x16b4f), (0x16b5a, 0x16b5a), (0x16b62, 0x16b62),
    (0x16b78, 0x16b7c), (0x16b90, 0x16e3f), (0x16e9b, 0x16eff), (0x16f4b, 0x16f4f),
    (0x16f51, 0x16f92), (0x16fa0, 0x16fdf), (0x16fe4, 0x16fff), (0x187f8, 0x187ff),
    (0x18cd6, 0x18cff), (0x18d09, 0x1afef), (0x1aff4, 0x1aff4), (0x1affc, 0x1affc),
    (0x1afff, 0x1afff), (0x1b123, 0x1b131), (0x1b133, 0x1b14f), (0x1b153, 0x1b154),
    (0x1b156, 0x1b163), (0x1b168, 0x1b16f), (0x1b2fc, 0x1bbff), (0x1bc6b, 0x1bc6f),
    (0x1bc7d, 0x1bc7f), (0x1bc89, 0x1bc8f), (0x1bc9a, 0x1bc9b), (0x1bc9d, 0x1bc9e),
    (0x1bca0, 0x1cf4f), (0x1cfc4, 0x1cfff), (0x1d0f6, 0x1d0ff), (0x1d127, 0x1d128),
    (0x1d165, 0x1d169), (0x1d16d, 0x1d182), (0x1d185, 0x1d18b), (0x1d1aa, 0x1d1ad),
    (0x1d1eb, 0x1d1ff), (0x1d242, 0x1d244), (0x1d246, 0x1d2bf), (0x1d2d4, 0x1d2df),
    (0x1d2f4, 0x1d2ff), (0x1d357, 0x1d35f), (0x1d379, 0x1d3ff), (0x1d455, 0x1d455),
    (0x1d49d, 0x1d49d), (0x1d4a0, 0x1d4a1), (0x1d4a3, 0x1d4a4), (0x1d4a7, 0x1d4a8),
    (0x1d4ad, 0x1d4ad), (0x1d4ba, 0x1d4ba), (0x1d4bc, 0x1d4bc), (0x1d4c4, 0x1d4c4),
    (0x1d506, 0x1d506), (0x1d50b, 0x1d50c), (0x1d515, 0x1d515), (0x1d51d, 0x1d51d),
    (0x1d53a, 0x1d53a), (0x1d53f, 0x1d53f), (0x1d545, 0x1d545), (0x1d547, 0x1d549),
    (0x1d551, 0x1d551), (0x1d6a6, 0x1d6a7), (0x1d7cc, 0x1d7cd), (0x1da00, 0x1da36),
    (0x1da3b, 0x1da6c), (0x1da75, 0x1da75), (0x1da84, 0x1da84), (0x1da8c, 0x1deff),
    (0x1df1f, 0x1df24), (0x1df2b, 0x1e02f), (0x1e06e, 0x1e0ff), (0x1e12d, 0x1e136),
    (0x1e13e, 0x1e13f), (0x1e14a, 0x1e14d), (0x1e150, 0x1e28f), (0x1e2ae, 0x1e2bf),
    (0x1e2ec, 0x1e2ef), (0x1e2fa, 0x1e2fe), (0x1e300, 0x1e4cf), (0x1e4ec, 0x1e4ef),
    (0x1e4fa, 0x1e7df), (0x1e7e7, 0x1e7e7), (0x1e7ec, 0x1e7ec), (0x1e7ef, 0x1e7ef),
    (0x1e7ff, 0x1e7ff), (0x1e8c5, 0x1e8c6), (0x1e8d0, 0x1e8ff), (0x1e944, 0x1e94a),
    (0x1e94c, 0x1e94f), (0x1e95a, 0x1e95d), (0x1e960, 0x1ec70), (0x1ecb5, 0x1ed00),
    (0x1ed3e, 0x1edff), (0x1ee04, 0x1ee04), (0x1ee20, 0x1ee20), (0x1ee23, 0x1ee23),
    (0x1ee25, 0x1ee26), (0x1ee28, 0x1ee28), (0x1ee33, 0x1ee33), (0x1ee38, 0x1ee38),
    (0x1ee3a, 0x1ee3a), (0x1ee3c, 0x1ee41), (0x1ee43, 0x1ee46), (0x1ee48, 0x1ee48),
    (0x1ee4a, 0x1ee4a), (0x1ee4c, 0x1ee4c), (0x1ee50, 0x1ee50), (0x1ee53, 0x1ee53),
    (0x1ee55, 0x1ee56), (0x1ee58, 0x1ee58), (0x1ee5a, 0x1ee5a), (0x1ee5c, 0x1ee5c),
    (0x1ee5e, 0x1ee5e), (0x1ee60, 0x1ee60), (0x1ee63, 0x1ee63), (0x1ee65, 0x1ee66),
    (0x1ee6b, 0x1ee6b), (0x1ee73, 0x1ee73), (0x1ee78, 0x1ee78), (0x1ee7d, 0x1ee7d),
    (0x1ee7f, 0x1ee7f), (0x1ee8a, 0x1ee8a), (0x1ee9c, 0x1eea0), (0x1eea4, 0x1eea4),
    (0x1eeaa, 0x1eeaa), (0x1eebc, 0x1eeef), (0x1eef2, 0x1efff), (0x1f02c, 0x1f02f),
    (0x1f094, 0x1f09f), (0x1f0af, 0x1f0b0), (0x1f0c0, 0x1f0c0), (0x1f0d0, 0x1f0d0),
    (0x1f0f6, 0x1f10a), (0x1f110, 0x1f12d), (0x1f130, 0x1f169), (0x1f170, 0x1f18d),
    (0x1f18f, 0x1f190), (0x1f19b, 0x1f1ac), (0x1f1ae, 0x1f1ff), (0x1f203, 0x1f20f),
    (0x1f23c, 0x1f23f), (0x1f249, 0x1f24f), (0x1f252, 0x1f25f), (0x1f266, 0x1f2ff),
    (0x1f3fb, 0x1f3ff), (0x1f6d8, 0x1f6db), (0x1f6ed, 0x1f6ef), (0x1f6fd, 0x1f6ff),
    (0x1f777, 0x1f77a), (0x1f7da, 0x1f7df), (0x1f7ec, 0x1f7ef), (0x1f7f1, 0x1f7ff),
    (0x1f80c, 0x1f80f), (0x1f848, 0x1f84f), (0x1f85a, 0x1f85f), (0x1f888, 0x1f88f),
    (0x1f8ae, 0x1f8af), (0x1f8b2, 0x1f8ff), (0x1fa54, 0x1fa5f), (0x1fa6e, 0x1fa6f),
    (0x1fa7d, 0x1fa7f), (0x1fa89, 0x1fa8f), (0x1fabe, 0x1fabe), (0x1fac6, 0x1facd),
    (0x1fadc, 0x1fadf), (0x1fae9, 0x1faef), (0x1faf9, 0x1faff), (0x1fb93, 0x1fb93),
    (0x1fbcb, 0x1fbef), (0x1fbfa, 0x1ffff), (0x2a6e0, 0x2a6ff), (0x2b73a, 0x2b73f),
    (0x2b81e, 0x2b81f), (0x2cea2, 0x2ceaf), (0x2ebe1, 0x2f7ff), (0x2fa1e, 0x2ffff),
    (0x3134b, 0x3134f), (0x323b0, 0x10ffff),
];

#[rustfmt::skip]
const WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115f), (0x231a, 0x231b), (0x2329, 0x232a), (0x23e9, 0x23ec),
    (0x23f0, 0x23f0), (0x23f3, 0x23f3), (0x25fd, 0x25fe), (0x2614, 0x2615),
    (0x2648, 0x2653), (0x267f, 0x267f), (0x2693, 0x2693), (0x26a1, 0x26a1),
    (0x26aa, 0x26ab), (0x26bd, 0x26be), (0x26c4, 0x26c5), (0x26ce, 0x26ce),
    (0x26d4, 0x26d4), (0x26ea, 0x26ea), (0x26f2, 0x26f3), (0x26f5, 0x26f5),
    (0x26fa, 0x26fa), (0x26fd, 0x26fd), (0x2705, 0x2705), (0x270a, 0x270b),
    (0x2728, 0x2728), (0x274c, 0x274c), (0x274e, 0x274e), (0x2753, 0x2755),
    (0x2757, 0x2757), (0x2795, 0x2797), (0x27b0, 0x27b0), (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c), (0x2b50, 0x2b50), (0x2b55, 0x2b55), (0x2e80, 0x2e99),
    (0x2e9b, 0x2ef3), (0x2f00, 0x2fd5), (0x2ff0, 0x2ffb), (0x3000, 0x3029),
    (0x3030, 0x303e), (0x3041, 0x3096), (0x309b, 0x30ff), (0x3105, 0x312f),
    (0x3131, 0x318e), (0x3190, 0x31e3), (0x31f0, 0x321e), (0x3220, 0x3247),
    (0x3250, 0x4dbf), (0x4e00, 0xa48c), (0xa490, 0xa4c6), (0xa960, 0xa97c),
    (0xac00, 0xd7a3), (0xf900, 0xfa6d), (0xfa70, 0xfad9), (0xfe10, 0xfe19),
    (0xfe30, 0xfe52), (0xfe54, 0xfe66), (0xfe68, 0xfe6b), (0xff01, 0xff60),
    (0xffe0, 0xffe6), (0x16fe0, 0x16fe3), (0x17000, 0x187f7), (0x18800, 0x18cd5),
    (0x18d00, 0x18d08), (0x1aff0, 0x1aff3), (0x1aff5, 0x1affb), (0x1affd, 0x1affe),
    (0x1b000, 0x1b122), (0x1b132, 0x1b132), (0x1b150, 0x1b152), (0x1b155, 0x1b155),
    (0x1b164, 0x1b167), (0x1b170, 0x1b2fb), (0x1f004, 0x1f004), (0x1f0cf, 0x1f0cf),
    (0x1f18e, 0x1f18e), (0x1f191, 0x1f19a), (0x1f200, 0x1f202), (0x1f210, 0x1f23b),
    (0x1f240, 0x1f248), (0x1f250, 0x1f251), (0x1f260, 0x1f265), (0x1f300, 0x1f320),
    (0x1f32d, 0x1f335), (0x1f337, 0x1f37c), (0x1f37e, 0x1f393), (0x1f3a0, 0x1f3ca),
    (0x1f3cf, 0x1f3d3), (0x1f3e0, 0x1f3f0), (0x1f3f4, 0x1f3f4), (0x1f3f8, 0x1f3fa),
    (0x1f400, 0x1f43e), (0x1f440, 0x1f440), (0x1f442, 0x1f4fc), (0x1f4ff, 0x1f53d),
    (0x1f54b, 0x1f54e), (0x1f550, 0x1f567), (0x1f57a, 0x1f57a), (0x1f595, 0x1f596),
    (0x1f5a4, 0x1f5a4), (0x1f5fb, 0x1f64f), (0x1f680, 0x1f6c5), (0x1f6cc, 0x1f6cc),
    (0x1f6d0, 0x1f6d2), (0x1f6d5, 0x1f6d7), (0x1f6dc, 0x1f6df), (0x1f6eb, 0x1f6ec),
    (0x1f6f4, 0x1f6fc), (0x1f7e0, 0x1f7eb), (0x1f7f0, 0x1f7f0), (0x1f90c, 0x1f93a),
    (0x1f93c, 0x1f945), (0x1f947, 0x1f9ff), (0x1fa70, 0x1fa7c), (0x1fa80, 0x1fa88),
    (0x1fa90, 0x1fabd), (0x1fabf, 0x1fac5), (0x1face, 0x1fadb), (0x1fae0, 0x1fae8),
    (0x1faf0, 0x1faf8), (0x20000, 0x2a6df), (0x2a700, 0x2b739), (0x2b740, 0x2b81d),
    (0x2b820, 0x2cea1), (0x2ceb0, 0x2ebe0), (0x2f800, 0x2fa1d), (0x30000, 0x3134a),
    (0x31350, 0x323af),
];
