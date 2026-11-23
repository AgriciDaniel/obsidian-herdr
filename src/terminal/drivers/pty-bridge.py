import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
cols = max(20, int(sys.argv[1]))
rows = max(5, int(sys.argv[2]))
cmd = sys.argv[3:]
master_fd, slave_fd = pty.openpty()
def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, 'short write')
        view = view[written:]
def exit_code_from_status(st):
    if hasattr(os, 'waitstatus_to_exitcode'):
        return os.waitstatus_to_exitcode(st)
    if os.WIFEXITED(st):
        return os.WEXITSTATUS(st)
    if os.WIFSIGNALED(st):
        return -os.WTERMSIG(st)
    return 1
def apply_winsz(fd, r, c):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError:
        pass
apply_winsz(master_fd, rows, cols)
apply_winsz(slave_fd, rows, cols)
pid = os.fork()
if pid == 0:
    os.setsid()
    os.close(master_fd)
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except OSError:
        pass
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    try:
        os.close(3)
    except OSError:
        pass
    try:
        os.execvp(cmd[0], cmd)
    except OSError as exc:
        try:
            os.write(2, ('exec failed: ' + str(exc) + '\n').encode('utf-8', 'replace'))
        except OSError:
            pass
        os._exit(127)
os.close(slave_fd)
ctrl_open = True
try:
    os.fstat(3)
except OSError:
    ctrl_open = False
ctrl_buf = b''
stdin_open = True
terminating = False
def handle_term(signum, _frame):
    global terminating
    terminating = True
    try:
        os.killpg(pid, signal.SIGHUP)
    except OSError:
        pass
signal.signal(signal.SIGTERM, handle_term)
signal.signal(signal.SIGHUP, handle_term)
while not terminating:
    watch = [master_fd]
    if stdin_open:
        watch.append(0)
    if ctrl_open:
        watch.append(3)
    try:
        rlist, _, _ = select.select(watch, [], [], 0.25)
    except InterruptedError:
        continue
    except OSError:
        break
    if master_fd in rlist:
        try:
            data = os.read(master_fd, 32768)
            if not data:
                break
            write_all(1, data)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                break
            raise
    if stdin_open and 0 in rlist:
        try:
            inp = os.read(0, 16384)
            if not inp:
                stdin_open = False
            else:
                write_all(master_fd, inp)
        except OSError:
            stdin_open = False
    if ctrl_open and 3 in rlist:
        try:
            chunk = os.read(3, 4096)
            if not chunk:
                ctrl_open = False
            else:
                ctrl_buf += chunk
                while b'\n' in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b'\n', 1)
                    if not line.strip():
                        continue
                    msg = json.loads(line.decode('utf-8', 'replace'))
                    if msg.get('type') == 'resize':
                        nc = max(10, int(msg.get('cols', cols)))
                        nr = max(3, int(msg.get('rows', rows)))
                        apply_winsz(master_fd, nr, nc)
                        try:
                            os.killpg(pid, signal.SIGWINCH)
                        except OSError:
                            pass
        except Exception:
            ctrl_open = False
    done_pid, status = os.waitpid(pid, os.WNOHANG)
    if done_pid == pid:
        while True:
            try:
                rem, _, _ = select.select([master_fd], [], [], 0.02)
                if not rem:
                    break
                tail = os.read(master_fd, 32768)
                if not tail:
                    break
                write_all(1, tail)
            except OSError:
                break
        os.close(master_fd)
        sys.exit(exit_code_from_status(status))
try:
    os.close(master_fd)
except OSError:
    pass
for sig in (signal.SIGTERM, signal.SIGKILL):
    done_pid, status = os.waitpid(pid, os.WNOHANG)
    if done_pid == pid:
        sys.exit(exit_code_from_status(status))
    try:
        os.killpg(pid, sig)
    except OSError:
        pass
    for _ in range(10):
        done_pid, status = os.waitpid(pid, os.WNOHANG)
        if done_pid == pid:
            sys.exit(exit_code_from_status(status))
        time.sleep(0.05)
sys.exit(0)
