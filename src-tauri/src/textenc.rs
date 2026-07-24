//! Text encoding detection and round-tripping for the config editor (Phase 39).
//!
//! Until now both readers (`sftp::read_text` and `localfile::read_text`) assumed
//! every editable file was UTF-8: a NUL byte meant "binary, refuse to open", and
//! anything that failed `String::from_utf8` was rejected outright. That holds on
//! a Linux server and breaks immediately on Windows, where config files are
//! routinely
//!
//!   * UTF-16LE (with or without a BOM) — PowerShell's default redirect output
//!     and a great many `.ini` files. Every ASCII character is followed by a NUL,
//!     so these tripped the binary check and reported "file appears to be binary".
//!   * a legacy ANSI codepage (CP1251 on a Russian install, CP1252 elsewhere) —
//!     these failed strict UTF-8 and reported "file is not valid UTF-8 text".
//!
//! So we decode on open and record which encoding it was, then re-encode in that
//! SAME encoding on save. That is the whole point: vterm must not silently
//! rewrite a UTF-16 `.ini` into UTF-8, because the program that owns the file
//! would then fail to read its own config.
//!
//! Detection order is deliberately "certain things first":
//!   1. a BOM — unambiguous, and it must be preserved on save;
//!   2. BOM-less UTF-16, spotted by the NUL-in-every-other-byte pattern;
//!   3. valid UTF-8 — the overwhelmingly common case, and never guessed at;
//!   4. `chardetng`'s legacy guess (Firefox's detector), which always yields
//!      something, so a mis-guess shows mojibake rather than refusing to open.
//!
//! Only step 4 is a guess. Steps 1–3 are exact, which means every file that
//! opened correctly before this module still round-trips byte-for-byte.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// How many leading bytes the heuristics look at. Enough to be representative
/// without reading a large file twice.
const SNIFF: usize = 4096;

/// Canonical encoding labels stored in `TextFile.encoding` and handed back on
/// save. Kept as plain strings because they cross the IPC boundary to the editor,
/// which carries the label on its `EditorDoc` and echoes it back untouched.
pub const UTF8: &str = "utf-8";
pub const UTF8_BOM: &str = "utf-8-bom";
pub const UTF16LE: &str = "utf-16le";
pub const UTF16LE_BOM: &str = "utf-16le-bom";
pub const UTF16BE: &str = "utf-16be";
pub const UTF16BE_BOM: &str = "utf-16be-bom";

/// A decoded text file plus the encoding it came in.
pub struct Decoded {
    pub text: String,
    /// Canonical label — one of the consts above, or a `encoding_rs` name such
    /// as `windows-1251` for a detected legacy codepage.
    pub encoding: String,
}

/// True when `bytes` look like UTF-16 in the given endianness: ASCII-range text
/// puts the NUL in a predictable half of each code unit. Requires a strong
/// majority so a UTF-8 file that merely contains a stray NUL isn't misread.
fn looks_utf16(bytes: &[u8], little_endian: bool) -> bool {
    let scan = bytes.len().min(SNIFF) & !1; // whole code units only
    if scan < 2 {
        return false;
    }
    let mut nul_in_expected = 0usize;
    let mut nul_in_other = 0usize;
    for pair in bytes[..scan].chunks_exact(2) {
        let (expected, other) = if little_endian {
            (pair[1], pair[0])
        } else {
            (pair[0], pair[1])
        };
        if expected == 0 {
            nul_in_expected += 1;
        }
        if other == 0 {
            nul_in_other += 1;
        }
    }
    let units = scan / 2;
    // Mostly-ASCII UTF-16 text: the high half is NUL nearly every time, and the
    // low half essentially never is.
    nul_in_expected * 2 > units && nul_in_other * 10 < units
}

/// Decode `bytes` as text, identifying the encoding. Returns `None` when the
/// content is binary rather than text — checked AFTER the UTF-16 sniff, since
/// UTF-16's interleaved NULs are exactly what the old binary test caught.
pub fn decode(bytes: &[u8]) -> Option<Decoded> {
    // 1. BOM — exact, and preserved on save.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (text, _) = UTF_8.decode_without_bom_handling(&bytes[3..]);
        return Some(Decoded {
            text: text.into_owned(),
            encoding: UTF8_BOM.into(),
        });
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _) = UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return Some(Decoded {
            text: text.into_owned(),
            encoding: UTF16LE_BOM.into(),
        });
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _) = UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return Some(Decoded {
            text: text.into_owned(),
            encoding: UTF16BE_BOM.into(),
        });
    }

    // 2. BOM-less UTF-16 (PowerShell `>` output, plenty of .ini files).
    if looks_utf16(bytes, true) {
        let (text, _) = UTF_16LE.decode_without_bom_handling(bytes);
        return Some(Decoded {
            text: text.into_owned(),
            encoding: UTF16LE.into(),
        });
    }
    if looks_utf16(bytes, false) {
        let (text, _) = UTF_16BE.decode_without_bom_handling(bytes);
        return Some(Decoded {
            text: text.into_owned(),
            encoding: UTF16BE.into(),
        });
    }

    // 3. Now that UTF-16 is excluded, a NUL really does mean binary.
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return None;
    }

    // 4. Plain UTF-8 — the common case, never a guess.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Some(Decoded {
            text: text.to_owned(),
            encoding: UTF8.into(),
        });
    }

    // 5. Legacy single-byte codepage. chardetng always returns an answer; a wrong
    //    guess shows mojibake, which the user can see and fix, rather than an
    //    error that hides an otherwise perfectly editable file.
    // ISO-2022-JP is denied: it is a stateful escape-sequence encoding and a false
    // positive would mangle a Western config far worse than a codepage mix-up.
    // UTF-8 is denied too — step 4 already proved this file is not valid UTF-8, so
    // letting the detector answer "utf-8" here could only produce replacement
    // characters.
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(&bytes[..bytes.len().min(SNIFF)], true);
    let enc = det.guess(None, chardetng::Utf8Detection::Deny);
    let (text, _, _) = enc.decode(bytes);
    Some(Decoded {
        text: text.into_owned(),
        encoding: enc.name().to_ascii_lowercase(),
    })
}

/// Re-encode editor text into `encoding`, re-emitting the BOM when the original
/// had one. An unknown label falls back to UTF-8 (the editor only ever hands
/// back a label we produced, so this is belt-and-braces).
pub fn encode(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        UTF8_BOM => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        UTF16LE | UTF16LE_BOM => {
            let mut out = if encoding == UTF16LE_BOM {
                vec![0xFF, 0xFE]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        UTF16BE | UTF16BE_BOM => {
            let mut out = if encoding == UTF16BE_BOM {
                vec![0xFE, 0xFF]
            } else {
                Vec::new()
            };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out
        }
        UTF8 => text.as_bytes().to_vec(),
        other => match Encoding::for_label(other.as_bytes()) {
            // encoding_rs refuses to *encode* UTF-16 (WHATWG maps those labels to
            // UTF-8 on output); we handled both above, so anything left here is a
            // single-byte legacy codepage, which round-trips fine.
            Some(enc) if enc != UTF_8 => {
                let (bytes, _, _) = enc.encode(text);
                bytes.into_owned()
            }
            _ => text.as_bytes().to_vec(),
        },
    }
}

/// The encoding label to use when creating brand-new content, or when a caller
/// has no recorded encoding for an existing file.
pub fn default_encoding() -> &'static str {
    UTF8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le_bytes(s: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        for u in s.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    #[test]
    fn plain_utf8_is_detected_exactly_and_round_trips() {
        let d = decode(b"[main]\nkey=value\n").unwrap();
        assert_eq!(d.encoding, UTF8);
        assert_eq!(d.text, "[main]\nkey=value\n");
        assert_eq!(encode(&d.text, &d.encoding), b"[main]\nkey=value\n");
    }

    #[test]
    fn utf8_bom_is_preserved_on_save() {
        let raw = b"\xEF\xBB\xBF[main]\nkey=value\n";
        let d = decode(raw).unwrap();
        assert_eq!(d.encoding, UTF8_BOM);
        // The BOM is not part of the text the editor sees...
        assert_eq!(d.text, "[main]\nkey=value\n");
        // ...but it comes back on save, byte for byte.
        assert_eq!(encode(&d.text, &d.encoding), raw);
    }

    // The headline Phase 39 bug: a UTF-16 .ini was rejected as "binary".
    #[test]
    fn utf16le_with_bom_opens_and_round_trips() {
        let raw = utf16le_bytes("[main]\r\nkey=значение\r\n", true);
        let d = decode(&raw).unwrap();
        assert_eq!(d.encoding, UTF16LE_BOM);
        assert_eq!(d.text, "[main]\r\nkey=значение\r\n");
        assert_eq!(encode(&d.text, &d.encoding), raw);
    }

    #[test]
    fn utf16le_without_bom_is_sniffed_and_round_trips() {
        let raw = utf16le_bytes("[main]\r\nkey=value\r\n", false);
        let d = decode(&raw).unwrap();
        assert_eq!(d.encoding, UTF16LE);
        assert_eq!(d.text, "[main]\r\nkey=value\r\n");
        assert_eq!(encode(&d.text, &d.encoding), raw);
    }

    #[test]
    fn utf16be_with_bom_opens_and_round_trips() {
        let mut raw = vec![0xFE, 0xFF];
        for u in "hello".encode_utf16() {
            raw.extend_from_slice(&u.to_be_bytes());
        }
        let d = decode(&raw).unwrap();
        assert_eq!(d.encoding, UTF16BE_BOM);
        assert_eq!(d.text, "hello");
        assert_eq!(encode(&d.text, &d.encoding), raw);
    }

    // The other half of the bug: an ANSI-codepage config failed strict UTF-8.
    #[test]
    fn legacy_cyrillic_codepage_opens_and_round_trips() {
        let text = "; настройки сервера\n[раздел]\nимя=значение\n";
        let (raw, _, _) = encoding_rs::WINDOWS_1251.encode(text);
        let d = decode(&raw).unwrap();
        assert_eq!(d.encoding, "windows-1251");
        assert_eq!(d.text, text);
        assert_eq!(encode(&d.text, &d.encoding), raw.into_owned());
    }

    #[test]
    fn real_binary_is_still_rejected() {
        // An ELF header — NULs that are not part of any UTF-16 pattern.
        let raw = b"\x7FELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        assert!(decode(raw).is_none());
    }

    #[test]
    fn utf8_with_a_stray_nul_is_binary_not_utf16() {
        // One NUL in otherwise-ASCII text must not be mistaken for UTF-16.
        let mut raw = b"key=value\n".to_vec();
        raw.push(0);
        raw.extend_from_slice(b"more text follows here\n");
        assert!(decode(&raw).is_none());
    }

    #[test]
    fn empty_file_decodes_as_empty_utf8() {
        let d = decode(b"").unwrap();
        assert_eq!(d.encoding, UTF8);
        assert_eq!(d.text, "");
        assert!(encode(&d.text, &d.encoding).is_empty());
    }

    #[test]
    fn unknown_label_falls_back_to_utf8() {
        assert_eq!(encode("abc", "not-an-encoding"), b"abc");
        assert_eq!(default_encoding(), UTF8);
    }

    #[test]
    fn windows_1252_label_round_trips() {
        let (raw, _, _) = encoding_rs::WINDOWS_1252.encode("caf\u{e9} na\u{ef}ve");
        let d = decode(&raw).unwrap();
        // Detector may land on any single-byte Western codepage; what matters is
        // that it decoded to the right text and re-encodes to the same bytes.
        assert_eq!(d.text, "caf\u{e9} na\u{ef}ve");
        assert_eq!(encode(&d.text, &d.encoding), raw.into_owned());
    }
}

/// Property-тесты: свойства, которые обязаны держаться на ЛЮБОМ входе.
///
/// Обычные тесты выше закрепляют разобранные случаи. Здесь — то, ради чего этот
/// модуль вообще существует: ему подают байты чужого файла, то есть вход, форму
/// которого мы не выбираем. Такой код проверяют потоком произвольных байтов, а
/// не списком примеров.
///
/// Глубина — через `PROPTEST_CASES` (ночной прогон поднимает её на порядок).
#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    fn cases() -> u32 {
        std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(256)
    }

    fn config() -> ProptestConfig {
        ProptestConfig {
            cases: cases(),
            ..ProptestConfig::default()
        }
    }

    proptest! {
        #![proptest_config(config())]

        /// Никакие байты не должны ронять декодер: это чужой файл, и «не текст»
        /// — штатный ответ `None`, а не паника.
        #[test]
        fn decode_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
            let _ = decode(&bytes);
        }

        /// То же для обратной стороны, включая незнакомую метку кодировки.
        #[test]
        fn encode_never_panics(text in ".{0,512}", label in "[a-zA-Z0-9-]{0,24}") {
            let _ = encode(&text, &label);
        }

        /// С BOM определение точное, поэтому round-trip обязан быть побайтовым
        /// и сохранять метку: молча переписать чужой UTF-16 в UTF-8 нельзя.
        #[test]
        fn bom_round_trips_exactly(text in ".{0,256}", which in 0usize..3) {
            let label = [UTF8_BOM, UTF16LE_BOM, UTF16BE_BOM][which];
            let d = decode(&encode(&text, label)).expect("текст с BOM — не бинарь");
            prop_assert_eq!(&d.text, &text);
            prop_assert_eq!(&d.encoding, label);
        }

        /// Регрессия, из-за которой `.ini` «не открывался»: UTF-16 БЕЗ BOM
        /// обязан читаться как текст. Перемежающиеся NUL'ы — это и есть UTF-16,
        /// а не признак бинаря, поэтому проверка бинарности идёт ПОСЛЕ sniff'а.
        #[test]
        fn bomless_utf16_ascii_is_text_not_binary(
            text in "[ -~]{1,256}",
            little_endian in any::<bool>(),
        ) {
            let label = if little_endian { UTF16LE } else { UTF16BE };
            let d = decode(&encode(&text, label))
                .expect("UTF-16 без BOM не должен считаться бинарём");
            prop_assert_eq!(&d.text, &text);
            prop_assert_eq!(&d.encoding, label);
        }

        /// Обычный UTF-8 без BOM: печатный текст читается как есть.
        #[test]
        fn plain_utf8_round_trips(text in "[ -~\\n\\t]{0,512}") {
            let d = decode(&encode(&text, UTF8)).expect("печатный ASCII — текст");
            prop_assert_eq!(&d.text, &text);
        }
    }
}
