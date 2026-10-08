"""Regenerate the export NFKC data with Python's standard Unicode database."""
import json
import sys
import unicodedata as u
from pathlib import Path
decomp, classes, compose, fold = {}, {}, {}, {}
for cp in range(0x110000):
    ch = chr(cp)
    if not 0xAC00 <= cp <= 0xD7A3:
        value = u.normalize("NFKD", ch)
        if value != ch:
            decomp[str(cp)] = [ord(c) for c in value]
    if u.combining(ch):
        classes[str(cp)] = u.combining(ch)
    raw = u.decomposition(ch).split()
    if len(raw) == 2 and not raw[0].startswith("<"):
        pair = [int(s, 16) for s in raw]
        if u.normalize("NFC", "".join(map(chr, pair))) == ch:
            compose[str(pair[0] * 0x110000 + pair[1])] = cp
    if ch.casefold() != ch.lower():
        fold[str(cp)] = ch.casefold()
data = {"version": u.unidata_version, "decomp": decomp, "classes": classes, "compose": compose, "fold": fold}
content = json.dumps(data, ensure_ascii=True, separators=(",", ":")) + "\n"
path = Path(sys.argv[1])
assert not path.exists()
path.write_bytes(content.encode("utf-8"))
assert path.read_bytes().decode("utf-8") == content and "\ufffd" not in content
print(u.unidata_version, len(content), len(decomp), len(compose))
