"""Create a new disposable project and physical-drop fixtures; never overwrite."""
import pathlib
import struct
import subprocess
import sys
import zlib

root = pathlib.Path(sys.argv[1])
if not root.is_absolute() or ".." in root.parts:
    raise SystemExit("Use a new absolute directory without parent traversal")
root.mkdir(mode=0o700)
(root / ".palisade-readiness-fixtures").touch()
project = root / "project"
project.mkdir()
(project / "greet.py").write_text('def greet(name):\n    return f"Hello, {name}!"\n\nassert greet("Palisade") == "Hello, Palisade!"\n')
(project / "README.md").write_text("# Disposable readiness project\n")
subprocess.run(["git", "init", "-b", "main", str(project)], check=True)
subprocess.run(["git", "-C", str(project), "add", "."], check=True)
subprocess.run(["git", "-C", str(project), "-c", "user.name=Readiness Test", "-c", "user.email=readiness@example.invalid", "commit", "-m", "Disposable baseline"], check=True)
drops = root / "drops"
drops.mkdir()
(drops / "external-context.txt").write_text("Physical drop test: DROP-731. Harmless disposable context.\n")
(drops / "unreadable.txt").write_text("Disposable partial-failure fixture.\n")
(drops / "unreadable.txt").chmod(0)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

pixels = b"".join(b"\0" + b"".join(bytes((60 if (x // 8 + y // 8) % 2 else 220, 100, 200)) for x in range(64)) for y in range(64))
(drops / "external-preview.png").write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
print(root)
