code review tools
=================
install
=======
Install bun: https://bun.sh/docs/installation

If you don't have `~/bin`:
```bash
$ mkdir ~/bin
# add to your .zshrc:
# export PATH="$HOME/bin:$PATH"
```

Symlink the script into your path:
```bash
# install dependencies
$ bun install
# symlink to the script in your PATH
$ ln -s "$PWD/git-pr-graph.ts" ~/bin/git-pr-graph
```

