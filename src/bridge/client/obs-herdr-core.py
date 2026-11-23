#!/usr/bin/env python3
import datetime, json, math, os, random, re, socket, subprocess, sys, threading, time

DEFAULT_CONN_FILE = "__OBS_HERDR_CONN_FILE__"
PLUGIN_VERSION = "__OBS_HERDR_PLUGIN_VERSION__"

SKILL_TEXT = "__OBS_HERDR_SKILL_TEXT__"

COMMAND_HELP = {}  # __OBS_HERDR_COMMAND_HELP__

UI_ALLOWED_FLAGS = {}  # __OBS_HERDR_UI_ALLOWED_FLAGS__

MCP_TOOLS = []  # __OBS_HERDR_MCP_TOOLS__

class BridgeRpcClientError(RuntimeError):
    pass

def is_ui_control_enabled_from_conn():
    cf = os.environ.get("OBSIDIAN_HERDR_CONNECTION_FILE") or DEFAULT_CONN_FILE
    if os.path.exists(cf):
        try:
            with open(cf, "r", encoding="utf-8") as fh:
                parsed = json.load(fh)
            if isinstance(parsed, dict) and isinstance(parsed.get("uiControlEnabled"), bool):
                return parsed["uiControlEnabled"]
        except Exception:
            pass
    return True

def resolve_conn():
    cf = os.environ.get("OBSIDIAN_HERDR_CONNECTION_FILE") or DEFAULT_CONN_FILE
    if cf and os.path.exists(cf):
        try:
            with open(cf, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if data.get("socketPath") and data.get("token"):
                return data["socketPath"], data["token"]
        except Exception:
            pass
    if os.environ.get("OBSIDIAN_HERDR_BRIDGE_SOCKET") and os.environ.get("OBSIDIAN_HERDR_BRIDGE_TOKEN"):
        return os.environ["OBSIDIAN_HERDR_BRIDGE_SOCKET"], os.environ["OBSIDIAN_HERDR_BRIDGE_TOKEN"]
    with open(cf, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["socketPath"], data["token"]

def resolve_timeout_ms(method, params):
    def clamp(ms):
        return min(600000, max(1000, int(round(ms))))
    env_raw = os.environ.get("OBS_HERDR_TIMEOUT_MS", "")
    # UI actions queue behind other agents' actions and a batch can run for minutes, so
    # they get 5 minutes by default; an explicit OBS_HERDR_TIMEOUT_MS still wins.
    base = 300000 if isinstance(method, str) and method.startswith("ui.") else 60000
    if env_raw != "":
        try:
            env_num = float(env_raw)
            if math.isfinite(env_num) and env_num > 0:
                base = clamp(env_num)
        except Exception:
            pass
    p = params if isinstance(params, dict) else {}
    if method == "ui.wait_for":
        try:
            w = float(p.get("timeoutMs")) if p.get("timeoutMs") is not None else 5000.0
            if not math.isfinite(w) or w < 0:
                w = 5000.0
        except Exception:
            w = 5000.0
        return clamp(max(base, int(round(w)) + 30000))
    if method == "ui.batch":
        total_wait = 0.0
        if p.get("timeoutMs") is not None:
            try:
                tw = float(p.get("timeoutMs"))
                if math.isfinite(tw) and tw >= 0:
                    total_wait += tw
            except Exception:
                pass
        steps = p.get("steps")
        if isinstance(steps, list):
            for s in steps:
                if isinstance(s, dict) and s.get("action") == "wait_for":
                    try:
                        sw = float(s.get("timeoutMs")) if s.get("timeoutMs") is not None else 5000.0
                        if not math.isfinite(sw) or sw < 0:
                            sw = 5000.0
                    except Exception:
                        sw = 5000.0
                    total_wait += sw
        if total_wait > 0:
            return clamp(max(base, int(round(total_wait)) + 30000))
    return clamp(base)

def call_bridge(method, params=None):
    sock_path, token = resolve_conn()
    caller = f"herdr:{os.environ['HERDR_PANE_ID']}" if os.environ.get("HERDR_PANE_ID") else "obs-herdr-py"
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    timeout_ms = resolve_timeout_ms(method, clean_params)
    req = {"id": f"py_{int(time.time()*1000)}_{random.randint(100000, 999999)}", "token": token, "method": method, "params": clean_params, "caller": caller}
    payload = (json.dumps(req) + "\n").encode("utf-8")
    buf = b""
    if os.name == "nt" and sock_path.startswith("\\\\.\\pipe\\"):
        box = {"buf": b"", "err": None}
        def _pipe_io():
            try:
                with open(sock_path, "r+b", buffering=0) as pipe_fh:
                    pipe_fh.write(payload)
                    local_buf = b""
                    while b"\n" not in local_buf:
                        chunk = pipe_fh.read(65536)
                        if not chunk:
                            break
                        local_buf += chunk
                    box["buf"] = local_buf
            except Exception as exc:
                box["err"] = exc
        t = threading.Thread(target=_pipe_io, daemon=True)
        t.start()
        t.join(timeout_ms / 1000.0)
        if t.is_alive():
            raise RuntimeError(f"Bridge request timed out after {timeout_ms} ms ({method}).")
        if box["err"] is not None:
            raise box["err"]
        buf = box["buf"]
    else:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout_ms / 1000.0)
            try:
                s.connect(sock_path)
                s.sendall(payload)
                while b"\n" not in buf:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
            except (socket.timeout, TimeoutError):
                raise RuntimeError(f"Bridge request timed out after {timeout_ms} ms ({method}).")
    if b"\n" not in buf:
        raise RuntimeError(f"Bridge connection closed before a complete response was received ({method}).")
    try:
        res = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid JSON response from Obsidian bridge: {exc}")
    if not isinstance(res, dict) or not res.get("ok"):
        err = res.get("error") if isinstance(res, dict) and isinstance(res.get("error"), dict) else {}
        raise BridgeRpcClientError(f"{err.get('code', 'error')}: {err.get('message', 'Bridge error')}")
    return res.get("result")

def parse_flags(args, strict=True):
    pos, flags = [], {"set": [], "unset": []}
    i = 0
    after_double_dash = False
    while i < len(args):
        a = args[i]
        if after_double_dash:
            pos.append(a)
            i += 1
            continue
        if a == "--":
            after_double_dash = True
            i += 1
            continue
        if a in ("--stdin", "--overwrite", "--help", "-h"):
            flags["help" if a == "-h" else a[2:]] = True
        elif a.startswith("--"):
            if "=" in a:
                key, val = a[2:].split("=", 1)
                if not key:
                    if strict:
                        raise RuntimeError(f"Invalid flag '{a}'.")
                    i += 1
                    continue
                if key in ("set", "unset"):
                    flags[key].append(val)
                else:
                    flags[key] = val
            elif i + 1 < len(args):
                key = a[2:]
                i += 1
                if key in ("set", "unset"):
                    flags[key].append(args[i])
                else:
                    flags[key] = args[i]
            elif strict:
                raise RuntimeError(f"Missing value for flag '{a}'.")
        elif re.match(r"^-[A-Za-z]", a):
            if strict:
                raise RuntimeError(f"Unknown flag '{a}'. Run 'obs-herdr --help' for usage.")
        else:
            pos.append(a)
        i += 1
    return pos, flags

def validate_ui_flags(sub, flags):
    allowed = UI_ALLOWED_FLAGS.get(sub)
    if allowed is None:
        return
    allowed_set = set(allowed)
    if flags.get("set") and "set" not in allowed_set:
        raise RuntimeError(f"Unknown flag '--set' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")
    if flags.get("unset") and "unset" not in allowed_set:
        raise RuntimeError(f"Unknown flag '--unset' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")
    for key in flags.keys():
        if key in ("set", "unset", "help"):
            continue
        if key not in allowed_set:
            raise RuntimeError(f"Unknown flag '--{key}' for 'obs-herdr ui {sub}'. Run 'obs-herdr ui {sub} --help' for usage.")

def resolve_help_text(argv):
    if not argv or argv[0] == "--skill":
        return SKILL_TEXT
    is_help_cmd = argv[0] == "help"
    pos, flags = parse_flags(argv[1:] if is_help_cmd else argv, strict=False)
    if not is_help_cmd and not flags.get("help"):
        return None
    group = pos[0] if len(pos) > 0 else ""
    sub = pos[1] if len(pos) > 1 else ""
    if not group:
        return SKILL_TEXT
    if not sub or group in ("mcp", "rpc"):
        if group in COMMAND_HELP["groups"]:
            return COMMAND_HELP["groups"][group]
        raise RuntimeError(f"Unknown obs-herdr command '{group}'. Run 'obs-herdr --help' for usage.")
    key = f"{group} {sub}"
    if key in COMMAND_HELP["commands"]:
        return COMMAND_HELP["commands"][key]
    raise RuntimeError(f"Unknown obs-herdr command '{key}'. Run 'obs-herdr --help' for usage.")

def parse_set(items):
    out = {}
    for item in items:
        t = str(item).strip()
        if t.startswith("{") and t.endswith("}"):
            out.update(json.loads(t))
        elif "=" in t:
            k, v = t.split("=", 1)
            key = k.strip()
            if not key:
                raise RuntimeError("--set requires key=value with a non-empty key.")
            out[key] = v
        else:
            raise RuntimeError("--set requires key=value with a non-empty key.")
    return out

def run_plugin_action(action):
    herdr_bin = os.environ.get("HERDR_BIN_PATH") or "herdr"
    if action == "vault-status":
        info = call_bridge("vault.info", {})
        subprocess.run([herdr_bin, "notification", "show", f"Vault: {info.get('vaultName', '')}", "--body", f"{info.get('markdownCount', 0)} notes ({info.get('permissionMode', 'off')})"], check=True)
    elif action == "active-note":
        st = call_bridge("workspace.get_state", {})
        subprocess.run([herdr_bin, "notification", "show", "Active note", "--body", st.get("activeFile") or "No active note"], check=True)
    elif action == "capture-pane":
        pane_id = (os.environ.get("HERDR_PANE_ID") or "").strip()
        if not pane_id or pane_id.startswith("-") or any(ch.isspace() for ch in pane_id):
            raise RuntimeError("HERDR_PANE_ID is not set or invalid in this pane environment.")
        proc = subprocess.run([herdr_bin, "pane", "read", pane_id, "--source", "recent-unwrapped", "--lines", "120"], capture_output=True, text=True, check=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", pane_id).replace("..", "-")
        trimmed = proc.stdout.strip()
        longest_run = max((len(m.group(0)) for m in re.finditer(r"`+", trimmed)), default=0)
        fence = "`" * max(3, longest_run + 1)
        note_path = f"Herdr Captures/Pane {safe_id} {stamp}.md"
        body = f"# Herdr Pane Capture ({pane_id})\n\n{fence}text\n{trimmed}\n{fence}\n"
        call_bridge("vault.create_note", {"path": note_path, "content": body})
        call_bridge("workspace.open_note", {"path": note_path})
        subprocess.run([herdr_bin, "notification", "show", "Saved pane to vault", "--body", note_path], check=True)

def to_mcp_content(res):
    if isinstance(res, dict) and isinstance(res.get("image"), dict) and isinstance(res["image"].get("data"), str):
        rest = {k: v for k, v in res.items() if k != "image"}
        return [
            {"type": "image", "data": res["image"]["data"], "mimeType": res["image"].get("mimeType") or "image/png"},
            {"type": "text", "text": json.dumps(rest, separators=(",", ":"))},
        ]
    return [{"type": "text", "text": json.dumps(res, separators=(",", ":"))}]

def parse_positive_int(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"[1-9][0-9]*", s):
        raise RuntimeError(f"--{flag_name} must be a positive integer.")
    n = int(s)
    if n < 1 or n > 9007199254740991:
        raise RuntimeError(f"--{flag_name} must be a positive integer.")
    return n

def parse_non_negative_int(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", s):
        raise RuntimeError(f"--{flag_name} must be a non-negative integer.")
    n = int(s)
    if n < 0 or n > 9007199254740991:
        raise RuntimeError(f"--{flag_name} must be a non-negative integer.")
    return n

def parse_finite_number(raw, flag_name):
    if raw is None:
        return None
    s = str(raw).strip()
    if not re.fullmatch(r"-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)", s):
        raise RuntimeError(f"--{flag_name} must be a finite number.")
    n = float(s)
    if not math.isfinite(n):
        raise RuntimeError(f"--{flag_name} must be a finite number.")
    return n

def parse_at_position(raw, flag_name):
    if raw is None:
        return None
    val = str(raw).strip()
    if val not in ("start", "end"):
        raise RuntimeError(f"--{flag_name} must be 'start' or 'end'.")
    return val

def ui_target(flags, prefix):
    note_key = (prefix + "note") if (prefix + "note") in flags else ((prefix + "path") if (prefix + "path") in flags else None)
    has_line = (prefix + "line") in flags
    has_after = (prefix + "after") in flags
    has_heading = (prefix + "heading") in flags
    has_at = (prefix + "at") in flags
    if note_key is not None:
        note = str(flags[note_key]).strip()
        if not note:
            raise RuntimeError(f"--{prefix}note cannot be empty.")
        target = {"note": note}
        if has_line:
            target["line"] = parse_positive_int(flags[prefix + "line"], prefix + "line")
        if has_after:
            target["after"] = str(flags[prefix + "after"])
        if has_heading:
            target["heading"] = str(flags[prefix + "heading"])
        if has_at:
            target["at"] = parse_at_position(flags[prefix + "at"], prefix + "at")
        return target
    if has_line or has_after or has_heading or has_at:
        raise RuntimeError(f"--{prefix}line/--after/--heading/--at requires --{prefix}note <path>.")
    if flags.get(prefix + "selector"):
        return {"selector": flags[prefix + "selector"]}
    if (prefix + "x") in flags and (prefix + "y") in flags:
        return {
            "x": parse_finite_number(flags[prefix + "x"], prefix + "x"),
            "y": parse_finite_number(flags[prefix + "y"], prefix + "y"),
        }
    return None

def save_screenshot(shot, out_flag):
    import base64
    conn_file = os.environ.get("OBSIDIAN_HERDR_CONNECTION_FILE") or DEFAULT_CONN_FILE
    out_path = out_flag
    if not out_path:
        shot_dir = os.path.join(os.path.dirname(conn_file), "screenshots")
        os.makedirs(shot_dir, mode=0o700, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")
        out_path = os.path.join(shot_dir, f"obsidian-{stamp}.png")
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(base64.b64decode(shot["image"]["data"]))
    rest = {k: v for k, v in shot.items() if k != "image"}
    return {"path": os.path.abspath(out_path), **rest}

def run_mcp():
    rpc_by_name = {t["name"]: t["rpc"] for t in MCP_TOOLS}
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        mid = msg.get("id")
        if mid is None:
            continue
        m = msg.get("method")
        try:
            if m == "initialize":
                out = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "obsidian-herdr-bridge", "version": PLUGIN_VERSION}}
            elif m == "tools/list":
                ui_enabled = is_ui_control_enabled_from_conn()
                visible = MCP_TOOLS if ui_enabled else [t for t in MCP_TOOLS if not str(t.get("rpc", "")).startswith("ui.")]
                out = {"tools": [{k: v for k, v in t.items() if k != "rpc"} for t in visible]}
            elif m == "tools/call":
                params = msg.get("params") or {}
                name = params.get("name")
                if name not in rpc_by_name:
                    raise RuntimeError(f"Unknown tool: {name}")
                try:
                    res = call_bridge(rpc_by_name[name], params.get("arguments") or {})
                    out = {"content": to_mcp_content(res)}
                except BridgeRpcClientError as bridge_exc:
                    out = {"content": [{"type": "text", "text": str(bridge_exc)}], "isError": True}
            else:
                out = {}
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": out}) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": str(exc)}}) + "\n")
            sys.stdout.flush()

def run_ui_inspect(flags):
    limit = parse_positive_int(flags.get("limit"), "limit")
    return call_bridge("ui.inspect", {"selector": flags.get("selector"), "text": flags.get("text"), "limit": limit})

def run_ui_locate(pos, flags):
    if "note" in flags:
        note_path = str(flags["note"]).strip()
    elif "path" in flags:
        note_path = str(flags["path"]).strip()
    else:
        note_path = pos[0] if pos else ""
    if not note_path:
        raise RuntimeError("Usage: obs-herdr ui locate (--note <path> | <vault-rel-path>) (--line <n> | --after <text> | --heading <h> | --text <t>) [--at start|end]")
    line_num = parse_positive_int(flags.get("line"), "line")
    search_text = str(flags["text"]) if "text" in flags else None
    after_text = str(flags["after"]) if "after" in flags else None
    heading_text = str(flags["heading"]) if "heading" in flags else None
    at_pos = parse_at_position(flags.get("at"), "at")
    if line_num is None and not search_text and not after_text and not heading_text:
        raise RuntimeError("ui locate requires --line <n>, --after <text>, --heading <h>, or --text <t>.")
    locate_params = {
        k: v for k, v in {
            "note": note_path,
            "path": note_path,
            "line": line_num,
            "text": search_text,
            "after": after_text,
            "heading": heading_text,
            "at": at_pos,
        }.items() if v is not None
    }
    return call_bridge("ui.locate", locate_params)

def run_ui_insert_line(pos, flags):
    anchor = ui_target(flags, "")
    if not anchor or not anchor.get("note"):
        raise RuntimeError("Usage: obs-herdr ui insert-line --note <path> (--line <n> | --after <text> | --heading <h>) [--at end|start] (--text <t> | --stdin)")
    if "line" not in anchor and not anchor.get("after") and not anchor.get("heading"):
        raise RuntimeError("ui insert-line requires --line <n>, --after <text>, or --heading <h>.")
    if flags.get("stdin"):
        text_val = sys.stdin.read()
    elif "text" in flags:
        text_val = str(flags["text"])
    elif pos:
        text_val = " ".join(pos)
    else:
        raise RuntimeError("ui insert-line requires --text <t> or --stdin.")
    try:
        return call_bridge("ui.insert_line", {"target": anchor, "text": text_val})
    except Exception as exc:
        if not str(exc).startswith("unknown_method:"):
            raise
        return call_bridge("ui.batch", {"steps": [{"action": "insert_line", "target": anchor, "text": text_val}]})

def main():
    argv = sys.argv[1:]
    help_text = resolve_help_text(argv)
    if help_text is not None:
        sys.stdout.write(help_text + "\n")
        return
    if argv[0] == "mcp":
        run_mcp()
        return
    if argv[0] == "plugin-action":
        run_plugin_action(argv[1] if len(argv) > 1 else "vault-status")
        return

    group = argv[0]
    sub = argv[1] if len(argv) > 1 else ""
    pos, flags = parse_flags(argv[2:])
    if group == "ui":
        validate_ui_flags(sub, flags)
    def pos_or_none(idx):
        return pos[idx] if len(pos) > idx else None

    if group == "vault" and sub == "info":
        res = call_bridge("vault.info", {})
    elif group == "note" and sub == "list":
        res = call_bridge("vault.list_files", {
            "folder": flags.get("folder"),
            "tag": flags.get("tag"),
            "extension": flags.get("extension"),
            "limit": parse_positive_int(flags.get("limit"), "limit"),
            "offset": parse_non_negative_int(flags.get("offset"), "offset"),
        })
    elif group == "note" and sub == "read":
        if not pos_or_none(0):
            raise RuntimeError("Usage: obs-herdr note read <vault-rel-path> [--offset-line <n>] [--max-lines <n>] [--max-chars <n>]")
        res = call_bridge("vault.read_note", {
            "path": pos_or_none(0),
            "offsetLine": parse_non_negative_int(flags.get("offset-line"), "offset-line"),
            "maxLines": parse_positive_int(flags.get("max-lines"), "max-lines"),
            "maxChars": parse_positive_int(flags.get("max-chars"), "max-chars"),
        })
    elif group == "note" and sub == "search":
        res = call_bridge("vault.search", {"query": pos_or_none(0), "limit": parse_positive_int(flags.get("limit"), "limit")})
    elif group == "note" and sub == "create":
        content = sys.stdin.read() if flags.get("stdin") else flags.get("content", "")
        res = call_bridge("vault.create_note", {"path": pos_or_none(0), "content": content, "overwrite": bool(flags.get("overwrite"))})
    elif group == "note" and sub == "update":
        content = sys.stdin.read() if flags.get("stdin") else flags.get("content", "")
        res = call_bridge("vault.update_note", {"path": pos_or_none(0), "mode": flags.get("mode", "append"), "heading": flags.get("heading"), "search": flags.get("search"), "content": content})
    elif group == "note" and sub == "frontmatter":
        res = call_bridge("vault.patch_frontmatter", {"path": pos_or_none(0), "set": parse_set(flags["set"]), "unset": flags["unset"]})
    elif group == "note" and sub == "rename":
        res = call_bridge("vault.rename_note", {"path": pos_or_none(0), "newPath": pos_or_none(1)})
    elif group == "note" and sub == "trash":
        res = call_bridge("vault.trash_note", {"path": pos_or_none(0)})
    elif group == "note" and sub == "backlinks":
        res = call_bridge("metadata.backlinks", {
            "path": pos_or_none(0),
            "limit": parse_positive_int(flags.get("limit"), "limit"),
            "offset": parse_non_negative_int(flags.get("offset"), "offset"),
        })
    elif group == "note" and sub == "graph":
        res = call_bridge("metadata.graph_neighbors", {
            "path": pos_or_none(0),
            "limit": parse_positive_int(flags.get("limit"), "limit"),
        })
    elif group == "canvas" and sub == "upsert":
        text_val = sys.stdin.read() if flags.get("stdin") else flags.get("text")
        res = call_bridge("canvas.upsert_node", {
            "path": pos_or_none(0),
            "id": flags.get("id"),
            "nodeType": flags.get("type") or flags.get("nodeType") or "text",
            "text": text_val,
            "file": flags.get("file"),
            "url": flags.get("url"),
            "label": flags.get("label"),
            "x": parse_finite_number(flags.get("x"), "x"),
            "y": parse_finite_number(flags.get("y"), "y"),
            "width": parse_finite_number(flags.get("width"), "width"),
            "height": parse_finite_number(flags.get("height"), "height"),
            "color": flags.get("color"),
        })
    elif group == "workspace" and sub == "state":
        res = call_bridge("workspace.get_state", {})
    elif group == "workspace" and sub == "open":
        res = call_bridge("workspace.open_note", {"path": pos_or_none(0), "line": parse_positive_int(flags.get("line"), "line"), "pane": flags.get("pane", "current")})
    elif group == "workspace" and sub == "notice":
        res = call_bridge("workspace.notice", {"message": " ".join(pos)})
    elif group == "editor" and sub == "selection":
        res = call_bridge("editor.selection", {})
    elif group == "editor" and sub == "insert":
        text_val = sys.stdin.read() if flags.get("stdin") else " ".join(pos)
        res = call_bridge("editor.insert_at_cursor", {"text": text_val})
    elif group == "command" and sub == "list":
        res = call_bridge("commands.list", {
            "query": flags.get("query") or (pos[0] if pos else ""),
            "limit": parse_positive_int(flags.get("limit"), "limit"),
            "offset": parse_non_negative_int(flags.get("offset"), "offset"),
        })
    elif group == "command" and sub == "run":
        res = call_bridge("commands.execute", {"commandId": pos_or_none(0)})
    elif group == "ui" and sub == "screenshot":
        if "out" in flags and "output" in flags and str(flags["out"]) != str(flags["output"]):
            raise RuntimeError("Conflicting values passed for --out and --output.")
        out_flag = flags["out"] if "out" in flags else flags.get("output")
        if out_flag is not None and str(out_flag).strip() == "":
            raise RuntimeError("--out/--output path cannot be empty.")
        shot = call_bridge("ui.screenshot", {"maxWidth": parse_positive_int(flags.get("max-width"), "max-width")})
        res = save_screenshot(shot, out_flag)
    elif group == "ui" and sub == "inspect":
        res = run_ui_inspect(flags)
    elif group == "ui" and sub == "locate":
        res = run_ui_locate(pos, flags)
    elif group == "ui" and sub == "insert-line":
        res = run_ui_insert_line(pos, flags)
    elif group == "ui" and sub == "wait":
        res = call_bridge("ui.wait_for", {"text": " ".join(pos), "selector": flags.get("selector"), "timeoutMs": parse_non_negative_int(flags.get("timeout"), "timeout")})
    elif group == "ui" and sub == "click":
        res = call_bridge("ui.click", {"target": ui_target(flags, ""), "button": flags.get("button"), "count": parse_positive_int(flags.get("count"), "count")})
    elif group == "ui" and sub == "select":
        sel_params = {"target": ui_target(flags, "")}
        if "value" in flags:
            sel_params["value"] = str(flags["value"])
        if "label" in flags:
            sel_params["label"] = str(flags["label"])
        res = call_bridge("ui.select", sel_params)
    elif group == "ui" and sub == "type":
        text_val = sys.stdin.read() if flags.get("stdin") else (str(flags["text"]) if "text" in flags else " ".join(pos))
        res = call_bridge("ui.type", {"text": text_val, "target": ui_target(flags, "")})
    elif group == "ui" and sub == "key":
        raw_key = pos[0] if pos else ""
        if raw_key == "+":
            key, parts = "+", []
        elif raw_key.endswith("++"):
            key = "+"
            parts = [p for p in raw_key[:-2].split("+") if p]
        else:
            parts = [p for p in raw_key.split("+") if p]
            key = parts.pop() if parts else ""
        res = call_bridge("ui.press_key", {"key": key, "modifiers": parts})
    elif group == "ui" and sub == "scroll":
        res = call_bridge("ui.scroll", {
            "target": ui_target(flags, ""),
            "deltaX": parse_finite_number(flags["dx"], "dx") if "dx" in flags else 0,
            "deltaY": parse_finite_number(flags["dy"], "dy") if "dy" in flags else 0,
        })
    elif group == "ui" and sub == "drag":
        res = call_bridge("ui.drag", {"from": ui_target(flags, "from-"), "to": ui_target(flags, "to-"), "steps": parse_positive_int(flags.get("steps"), "steps")})
    elif group == "ui" and sub == "batch":
        if "steps-json" in flags and str(flags["steps-json"]).strip() == "":
            raise RuntimeError("--steps-json cannot be empty.")
        raw_steps = str(flags["steps-json"]) if "steps-json" in flags else (sys.stdin.read() if flags.get("stdin") else (pos[0] if pos else "[]"))
        res = call_bridge("ui.batch", {"steps": json.loads(raw_steps)})
    elif group == "rpc":
        res = call_bridge(sub, json.loads(pos[0]) if pos else {})
    else:
        raise RuntimeError("Unknown obs-herdr command. Run 'obs-herdr --help' for usage.")
    sys.stdout.write(json.dumps(res, indent=2) + "\n")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(str(e) + "\n")
        sys.exit(1)
