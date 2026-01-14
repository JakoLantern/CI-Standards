#!/usr/bin/env node
/**
 * GitHub PR Code Review Comment Generator
 * Analyzes changed files in a PR and posts review comments for code violations
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Import checking functions from existing standards modules
const {
  getJsDocInfo,
  extractParams,
  getAccessModifier,
  checkAccessModifierTag,
  hasReturnsTag,
  checkParamTags
} = require('./check-code-standards.js');

const {
  checkCSSFile: checkCSSFileForTailwind,
  TAILWIND_PROPERTIES,
  HARDCODED_PATTERNS
} = require('./check-tailwind-standards.js');

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
  // Check if line is within the actual diff hunks
  return changedRanges.some(
    range => lineNum >= range.start && lineNum <= range.end
  );
}

function isNearChangedLine(lineNum, changedRanges) {
  // Check if line is within diff OR within 5 lines after a change
  // This catches function declarations after modified JSDoc comments
  return changedRanges.some(
    range => lineNum >= range.start && lineNum <= range.end + 5
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

      // Enhanced JSDoc checks using check-code-standards logic
      // Skip Angular reactive properties (computed, signal, input, output, viewChild)
      const isAngularReactive = /=\s*(computed|signal|input|output|viewChild)\s*[<(]/.test(line);
      
      // Only match actual method declarations with return type annotation (filters out if, setTimeout, etc)
      const methodRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*\([^)]*\)\s*:\s*[A-Za-z0-9_[\]|<>]+[ \t]*\{/;
      if (methodRegex.test(line) && !isAngularReactive && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        
        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Public functions need documentation with description, parameters, and return type.'
          });
        } else {
          // Check for @returns tag
          if (!hasReturnsTag(jsDocInfo.content) && !line.includes(': void')) {
            comments.push({
              path: file,
              line: lineNum,
              body: '📚 **JSDoc Standard**: Missing `@returns` tag in JSDoc.'
            });
          }
          
          // Check access modifier tag matches code
          const actualModifier = getAccessModifier(line);
          const accessCheck = checkAccessModifierTag(jsDocInfo.content, actualModifier);
          if (!accessCheck.valid) {
            comments.push({
              path: file,
              line: lineNum,
              body: `📚 **JSDoc Standard**: ${accessCheck.message}`
            });
          }
          
          // Check param tags
          const params = extractParams(line);
          const paramCheck = checkParamTags(jsDocInfo.content, params);
          if (!paramCheck.valid) {
            for (const err of paramCheck.errors) {
              comments.push({
                path: file,
                line: lineNum,
                body: `📚 **JSDoc Standard**: ${err}`
              });
            }
          }
        }
        
        // Check for return type annotation
        const actualModifier = getAccessModifier(line);
        if (actualModifier && !/:\s*[A-Za-z0-9_[\]|<>]+/.test(line)) {
          comments.push({
            path: file,
            line: lineNum,
            body: '⚠️ **Code Standard**: Method missing return type annotation.'
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
  
  // Use the imported checkCSSFileForTailwind function
  const violations = checkCSSFileForTailwind(file);
  
  // Filter violations to only those in changed lines and convert to PR comment format
  for (const violation of violations) {
    if (isLineChanged(violation.line, changedRanges)) {
      const emoji = violation.severity === 'error' ? '❌' : '🎨';
      const severity = violation.severity === 'error' ? 'Error' : 'CSS Standard';
      
      comments.push({
        path: file,
        line: violation.line,
        body: `${emoji} **${severity}**: ${violation.message}\n\nSuggestion: Use Tailwind \`${violation.tailwind}\` instead.`
      });
    }
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
  if (!file.endsWith('.ts') || file.endsWith('.spec.ts') || file.endsWith('.stories.ts')) continue;
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

// Exit 0 so output is captured properly
process.exit(0);
