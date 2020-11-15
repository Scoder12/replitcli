const fs = require("fs").promises;
const path = require("path");

const { createCommand } = require("commander");

const logs = require("../logs");
const { getRepl } = require("../utils");
const { getClient } = require("../connect");
const chalk = require("chalk");

const PREFIX = "repl:";

function parsePathArg(arg) {
  if (arg.startsWith(PREFIX)) {
    return {
      path: arg.slice(PREFIX.length),
      isRepl: true,
    };
  } else {
    return {
      path: arg,
      isRepl: false,
    };
  }
}

function cleanReplPath(p) {
  // From http://protodoc.turbio.repl.co/services#gcsfiles
  // > Paths should ALWAYS be relative without any leading ./ or /. Paths should NEVER
  // > have a trailing / even when refering to a directory.To refer to a file or
  // > directory inside the project use the path with no leading or trailing characters
  // > (e.g. "dir/myfile.txt" or "mydir").To refer to the working directory (aka
  // > projects root) use "".

  return p
    .replace(/^\.\//g, "") // Strip leading "./"
    .replace(/\/$/g, ""); // Strip trailing "/"
}

async function main(passedSrc, passedDest, passedRepl) {
  // Parse src / dest
  const src = parsePathArg(passedSrc);
  const dest = parsePathArg(passedDest);

  // Check for error *before* connecting
  if (!src.isRepl && !dest.isRepl) {
    logs.fatal(
      "You specified two local paths. " +
        "Use " +
        chalk.green("repl:") +
        " before a path to indicate it is on the repl. "
    );
  }

  const replId = await getRepl(passedRepl);
  const conn = await getClient(replId);

  const logStatus = (line) => process.stderr.write(line + "\n");

  try {
    if (src.isRepl && dest.isRepl) {
      // Use cp to copy in-repl.
      logStatus("Executing cp in repl...");
      const chan = conn.channel("exec");
      await chan.request({ exec: { args: ["cp", src.path, dest.path] } });
    } else if (!src.isRepl && dest.isRepl) {
      let toCopy = [{ srcPath: src.path, destPath: dest.path }];
      let isTopLevel = true;

      while (toCopy.length) {
        const { srcPath, destPath } = toCopy.shift();
        // Stat the provided source to determine whether it is a file or directory.
        const stat = await fs.stat(srcPath);
        // If its a directory, push all of its files into the queue
        if (stat.isDirectory()) {
          const files = await fs.readdir(srcPath);
          // Repl.it uses linux, so use path.posix to join
          // Push the files into the queue.
          toCopy = toCopy.concat(
            files.map((f) => ({
              srcPath: path.join(srcPath, f),
              destPath: path.posix.join(destPath, f),
            }))
          );
        } else if (!stat.isFile) {
          // Only warn if the user-provided file is not copyable. If we found it while
          //  traversing recursively, silently ignore
          if (isTopLevel) {
            logs.fatal(
              "Cannot copy a path that is neither a file nor directory"
            );
          }
          logs.debug(
            `Ignoring non-directory non-file ${JSON.stringify(srcPath)}`
          );
        } else {
          // Read a local file and copy it into the repl.
          logStatus(`Reading local file ${JSON.stringify(srcPath)}...`);
          const srcBuffer = await fs.readFile(srcPath);
          const cleanDest = cleanReplPath(destPath);
          logStatus(`Writing remote file ${JSON.stringify(cleanDest)}...`);
          await conn.channel("files").request({
            write: {
              path: cleanDest,
              content: srcBuffer.toString("base64"),
            },
          });
        }
        isTopLevel = false;
      }
    } else if (src.isRepl && !dest.isRepl) {
      // Read from the repl
      logStatus(`Reading remote file ${JSON.stringify(src.path)}...`);
      const { file } = await conn.channel("files").request({
        read: { path: cleanReplPath(src.path) },
      });
      logStatus(
        `Writing ${file.content.length} bytes to local file ${JSON.stringify(
          dest.path
        )}...`
      );
      await fs.writeFile(dest.path, file.content);
    } else {
      logs.fatal("Unknown configuration");
    }
  } catch (e) {
    console.error(e);
  } finally {
    try {
      client.close();
    } catch (e) {}
    // For some reason, process hangs if we don't include this.
    process.exit(0);
  }
}

module.exports = createCommand()
  .storeOptionsAsProperties(false)
  .passCommandToAction(false)
  .name("cp")
  .description(
    "Copies a file from a repl to your computer or vice versa. " +
      "Prepend a path with " +
      chalk.green("repl:") +
      " to indicate it is on the repl."
  )
  .arguments("<src> <dest> [repl]")
  .action(main);
