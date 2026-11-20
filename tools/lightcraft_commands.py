import json, re, sys, pathlib
src = pathlib.Path(sys.argv[1])
tok = re.compile(r'r#"(.*?)"#|"((?:[^"\\]|\\.)*)"|(\[)|(\])|(None)|(Some\()|(,)|(\))|(query)', re.S)
out = []
for f in sorted(src.rglob("*.rs")):
    t = f.read_text()
    for m in re.finditer(r'cmd!\(\s*', t):
        i = m.end(); depth = 0; strs = []; menu = []; in_menu = False; shortcut = None; field = 0
        # walk tokens until the 5th top-level comma-separated field (params) is read
        while i < len(t) and field < 5:
            mm = tok.search(t, i)
            if not mm: break
            i = mm.end()
            s = mm.group(1) if mm.group(1) is not None else mm.group(2)
            if s is not None:
                s = s.encode().decode('unicode_escape').encode('latin-1').decode('utf-8') if mm.group(2) is not None else s
                if in_menu: menu.append(s)
                elif field == 3: shortcut = s
                else: strs.append((field, s))
            elif mm.group(3): in_menu = True
            elif mm.group(4): in_menu = False
            elif mm.group(7) and not in_menu: field += 1
        d = dict(strs)
        if 0 in d and 1 in d:
            out.append({"id": d[0], "label": d[1], "menu": menu, "shortcut": shortcut, "params": d.get(4, "")})
seen = {}
for c in out: seen.setdefault(c["id"], c)
json.dump(sorted(seen.values(), key=lambda c: c["id"]), open(sys.argv[2], "w"), ensure_ascii=False, separators=(",", ":"))
print(len(seen))
