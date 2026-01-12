#!/usr/bin/env node
/**
 * GitHub PR Code Review Comment Generator
 * Analyzes changed files in a PR and posts review comments for code violations
 */

const fs = require('fs');
const { execSync } = require('child_process');

const CONTEXT_LINES = 3; // Small context for actual diff lines only
const baseRef = process.env.BASE_REF || 'origin/main';

function getChangedLineRanges(file) {
  try {
    const diffOutput = execSync(
      `git diff -U0 ${baseRef}...HEAD -- "${file}"`
    ).toString();

    const ranges = [];
    const lines = diffOutput.split('\n');
    let currentLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1]);
        const count = parseInt(hunkMatch[2]) || 1;
        // Track the entire hunk range
        ranges.push({ start: currentLine, end: currentLine + count - 1 });
        continue;
      }

      if (!line.startsWith('-') && !line.startsWith('\\') && !line.startsWith('+++')) {
        currentLine++;
      }
    }

    return ranges;
  } catch (error) {
    console.error(`Could not get diff for ${file}`);
    return [];
  }
}

function isLineChanged(lineNum, changedRanges) {
  // Only return true if line is within the actual diff hunks
  return changedRanges.some(
    range => lineNum >= range.start && lineNum <= range.end
  );
}

function checkTypeScriptFile(file, changedRanges) {
  const comments = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      if (!isLineChanged(lineNum, changedRanges)) return;

      // console.log check
      if (line.includes('console.log')) {
        comments.push({
          path: file,
          line: lineNum,
          body: '⚠️ **Code Standard Violation**: `console.log()` should not be in production code. Use a logging service instead.'
        });
      }

      // debugger check
      if (line.includes('debugger')) {
        comments.push({
          path: file,
          line: lineNum,
          body: '❌ **Critical**: `debugger` statement must be removed before merge.'
        });
      }

      // TODO check
      if (line.includes('TODO')) {
        comments.push({
          path: file,
          line: lineNum,
          body: '📝 **TODO**: Track in issue tracker or resolve before merge.'
        });
      }

      // FIXME check
      if (line.includes('FIXME')) {
        comments.push({
          path: file,
          line: lineNum,
          body: '🔧 **FIXME**: This issue needs to be resolved before merge.'
        });
      }

      // JSDoc checks
      const invalidJSDocPattern = /^\s*\/\/\s*[a-zA-Z]/;
      if (invalidJSDocPattern.test(line)) {
        if (index + 1 < lines.length) {
          const nextLine = lines[index + 1].trim();
          const isFunctionDecl =
            nextLine.match(/^\s*(public\s+)?(async\s+)?([a-zA-Z_$]\w*)\s*\(/) ||
            nextLine.match(/^\s*(get|set|constructor)\s*\(/);

          if (isFunctionDecl) {
            comments.push({
              path: file,
              line: lineNum,
              body: '📚 **JSDoc Standard**: Use proper JSDoc format: `/** description */` for functions.'
            });
          }
        }
      }

      // Missing JSDoc check
      const functionPattern = /^\s*(public\s+)?(async\s+)?([a-zA-Z_$]\w*)\s*\(/;
      if (functionPattern.test(line) && !line.trim().startsWith('constructor')) {
        let hasJSDoc = false;
        for (let i = index - 1; i >= Math.max(0, index - 5); i--) {
          if (lines[i].includes('*/')) {
            hasJSDoc = true;
            break;
          }
        }

        if (!hasJSDoc) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Public functions need documentation with description and parameters.'
          });
        }
      }
    });
  } catch (error) {
    console.error(`Error reading ${file}: ${error.message}`);
  }

  return comments;
}

function checkCSSFile(file, changedRanges) {
  const comments = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      if (!isLineChanged(lineNum, changedRanges)) return;

      // Hardcoded colors check
      if (/\b(white|black|red|blue|green|yellow)\b/.test(line)) {
        if (/(color|background-color|border-color):\s*/.test(line)) {
          comments.push({
            path: file,
            line: lineNum,
            body: '🎨 **CSS Standard**: Use Tailwind utilities instead of hardcoded colors (e.g., `text-white` instead of `color: white`).'
          });
        }
      }

      // Tailwind properties check
      const tailwindProps = [
        'padding:',
        'margin:',
        'display:',
        'font-size:',
        'border-radius:',
        'max-width:',
        'width:',
        'height:'
      ];

      for (const prop of tailwindProps) {
        if (line.includes(prop)) {
          comments.push({
            path: file,
            line: lineNum,
            body: `🎨 **CSS Standard**: Use Tailwind utilities for \`${prop.replace(':', '')}\` instead of inline CSS.`
          });
          break;
        }
      }
    });
  } catch (error) {
    console.error(`Error reading ${file}: ${error.message}`);
  }

  return comments;
}

// Main execution
const changedFilesOutput = execSync(`git diff --name-only --diff-filter=ACMTU ${baseRef}...HEAD`)
  .toString()
  .trim()
  .split('\n')
  .filter(f => f.length > 0);

console.error('📄 Changed files:', changedFilesOutput);

let allComments = [];

// Check TypeScript files
for (const file of changedFilesOutput) {
  if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
  const ranges = getChangedLineRanges(file);
  if (ranges.length === 0) continue;
  allComments = allComments.concat(checkTypeScriptFile(file, ranges));
}

// Check CSS files
for (const file of changedFilesOutput) {
  if (!file.endsWith('.css')) continue;
  const ranges = getChangedLineRanges(file);
  if (ranges.length === 0) continue;
  allComments = allComments.concat(checkCSSFile(file, ranges));
}

// Output results - logs to stderr, JSON to stdout
console.error(`\n✓ Found ${allComments.length} violations`);
console.log(JSON.stringify(allComments, null, 2));

process.exit(allComments.length > 0 ? 1 : 0);
