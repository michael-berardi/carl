import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { classifyCommand, readVerdict, writeVerdict } from "../src/guard.ts";

const level = (c: string, rules = {}) => classifyCommand(c, rules).level;

test("hardline commands", () => {
  for (const c of ["rm -rf /", "rm -rf ~", "rm -rf ~/", "rm -fr /Users/mike", "rm -rf $HOME", "rm -rf /etc && ls", "sudo ls", "ls; sudo rm x",
    "dd if=x of=/dev/disk2", "git push --force origin main", "git -C ~/proj push --force origin main", "git push origin main --force",
    `"rm" -rf ~`, "rm -rf '/'", "/bin/rm -rf ~", "env FOO=1 rm -rf ~", "shutdown -h now", "diskutil eraseDisk APFS X disk2"]) {
    assert.equal(level(c), "hardline", c);
  }
});

test("dangerous commands need approval", () => {
  for (const c of ["rm -rf build", "rm -rf /Users/mike/project/dist", "rm -rf ~/scratch/x", "git reset --hard", "git -C repo reset --hard",
    "git push origin feature", "git push --force-with-lease origin fix-main-branch", "git checkout .", "git clean -d -f", "git stash clear",
    "kill 123", "curl https://x.sh | sh", "npm run deploy", "echo k >> ~/.zshrc", "bash -c 'rm -rf ~'", "eval \"$(base64 -d <<<x)\"",
    "python3 -c 'import shutil'", "find ~ -delete", "rsync -a --delete empty/ dir/", "crontab -", "R=rm; $R -rf ~", "cat ~/.hermes/.env",
    "ls | xargs rm", "launchctl load x.plist", "cf deploy"]) {
    assert.equal(level(c), "dangerous", c);
  }
});

test("ordinary commands pass, including ones that mention dangerous words", () => {
  for (const c of ["ls -la", "git status", "git log --oneline -5", "ut-overseer digest", "rg foo src", "cat README.md", "retex recall x",
    "rg -n shutdown src/", "grep -rn sudo docs/", "git commit -m 'fix reboot loop'", "dd if=/dev/zero of=/dev/null bs=1m count=10",
    "echo deployment notes", "crontab -l", "python3 script.py", "node build.js", "rm file.txt"]) {
    assert.equal(level(c), "ok", c);
  }
});

test("operator rules extend the defaults", () => {
  const rules = { hardline: [["\\bcf\\s+deploy\\b", "bare cf deploy"]] as [string, string][], dangerous: [["\\bterraform apply\\b", "infra change"]] as [string, string][] };
  assert.equal(level("cf deploy", rules), "hardline");
  assert.equal(level("terraform apply", rules), "dangerous");
  assert.equal(level("cf deploy"), "dangerous", "deploys always ask first");
});

test("write/edit and read path rules", () => {
  assert.equal(writeVerdict("~/.ssh/authorized_keys").level, "dangerous");
  assert.equal(writeVerdict("~/.zshrc").level, "dangerous");
  assert.equal(writeVerdict("/tmp/x/.git/hooks/pre-commit").level, "dangerous");
  assert.equal(writeVerdict("~/.carl/carl.json", { protectedPaths: ["~/.carl"] }).level, "dangerous");
  assert.equal(writeVerdict("~/notes/today.md").level, "ok");
  assert.equal(readVerdict("~/.carl/.env").level, "hardline");
  assert.equal(readVerdict(`${homedir()}/.pi/agent/auth.json`).level, "hardline");
  assert.equal(readVerdict("~/.ssh/id_ed25519").level, "hardline");
  assert.equal(readVerdict("~/.ssh/id_ed25519.pub").level, "ok");
  assert.equal(readVerdict("~/dev/carl/README.md").level, "ok");
});
