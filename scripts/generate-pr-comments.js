#!/usr/bin/env node
/**
 * GitHub PR Code Review Comment Generator
 * Analyzes changed files in a PR and posts review comments for code violations
 * Imports logic from check-code-standards.js and check-tailwind-standards.js
 */

const fs = require('fs');
const { execSync } = require('child_process');

// Import checking utilities from other scripts
const {
  getJsDocInfo,
  extractParams,
  getAccessModifier,
  checkAccessModifierTag,
  hasReturnsTag,
  checkParamTags
} = require('./check-code-standards.js');

const {
  checkCSSFile: checkCSSFileFromTailwind
} = require('./check-tailwind-standards.js');

const CONTEXT_LINES = 3; // Small context for actual diff lines only
const baseRef = process.env.BASE_REF || 'origin/main';

// ============================================================================
// Git Diff Utilities
// ============================================================================

/**
 * Gets the line ranges that were changed in a file compared to the base branch
 * @param {string} file - Path to the file to check
 * @returns {Array<{start: number, end: number}>} Array of line range objects with start and end line numbers
 */
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

/**
 * Checks if a specific line number falls within any of the changed line ranges
 * @param {number} lineNum - The line number to check
 * @param {Array<{start: number, end: number}>} changedRanges - Array of changed line ranges
 * @returns {boolean} True if the line was changed in the diff
 */
function isLineChanged(lineNum, changedRanges) {
  // Check if line is within the actual diff hunks
  return changedRanges.some(
    range => lineNum >= range.start && lineNum <= range.end
  );
}

/**
 * Checks if a line is within or near (5 lines after) any changed line ranges
 * Useful for catching function declarations that follow modified JSDoc comments
 * @param {number} lineNum - The line number to check
 * @param {Array<{start: number, end: number}>} changedRanges - Array of changed line ranges
 * @returns {boolean} True if the line is within or near a changed range
 */
function isNearChangedLine(lineNum, changedRanges) {
  // Check if line is within diff OR within 5 lines after a change
  // This catches function declarations after modified JSDoc comments
  return changedRanges.some(
    range => lineNum >= range.start && lineNum <= range.end + 5
  );
}

// ============================================================================
// TypeScript File Checker (Enhanced from check-code-standards.js)
// ============================================================================

/**
 * Checks TypeScript files for code standard violations on changed lines
 * @param {string} file - Path to the TypeScript file to check
 * @param {Array<{start: number, end: number}>} changedRanges - Array of changed line ranges from git diff
 * @returns {Array<{path: string, line: number, body: string}>} Array of violation comments for PR review
 */
function checkTypeScriptFile(file, changedRanges) {
  const comments = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    // Regex patterns for Angular signals, computed, inputs, outputs
    const methodRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*\([^)]*\)\s*:\s*[A-Za-z0-9_[\]|<>]+[ \t]*\{/;
    const computedRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*computed\s*[<(]/;
    const signalRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*signal\s*[<(]/;
    const inputRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*=\s*input(\.required)?\s*[<(]/;
    const outputRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*=\s*output\s*[<(]/;
    const viewChildRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*viewChild(\.required)?\s*[<(]/;

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
    });

    // Check methods/functions (use isNearChangedLine for JSDoc-related checks)
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      
      if (methodRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const actualModifier = getAccessModifier(line);
        const hasReturnType = /:\s*[A-Za-z0-9_[\]|<>]+/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Methods require proper JSDoc documentation with description, @param tags, and @returns.'
          });
        } else {
          // Check for @returns tag
          if (!hasReturnsTag(jsDocInfo.content)) {
            comments.push({
              path: file,
              line: lineNum,
              body: '📚 **JSDoc Standard**: Missing `@returns` tag describing the return value.'
            });
          }

          // Check access modifier tag
          const accessCheck = checkAccessModifierTag(jsDocInfo.content, actualModifier);
          if (!accessCheck.valid) {
            comments.push({
              path: file,
              line: lineNum,
              body: `📚 **JSDoc Standard**: ${accessCheck.message}`
            });
          }

          // Check @param tags
          const params = extractParams(line);
          const paramCheck = checkParamTags(jsDocInfo.content, params);
          if (!paramCheck.valid) {
            paramCheck.errors.forEach(err => {
              comments.push({
                path: file,
                line: lineNum,
                body: `📚 **JSDoc Standard**: ${err}`
              });
            });
          }
        }

        if (!actualModifier) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Method missing access modifier (public/private/protected).'
          });
        }

        if (!hasReturnType) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Method missing explicit return type annotation.'
          });
        }
      }

      // Check computed properties
      if (computedRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const hasAccess = /(public|private|protected)/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Computed property requires single-line JSDoc (/** description */).'
          });
        } else if (!jsDocInfo.isSingleLine) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **JSDoc Standard**: Computed property should have single-line JSDoc, not multi-line.'
          });
        } else {
          const content = jsDocInfo.content.replace(/\/\*\*|\*\//g, '').trim();
          if (!content) {
            comments.push({
              path: file,
              line: lineNum,
              body: '📚 **JSDoc Standard**: JSDoc is empty - add a description.'
            });
          }
        }

        if (!hasAccess) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Computed property missing access modifier (public/private/protected).'
          });
        }
      }

      // Check signal properties
      if (signalRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const hasAccess = /(public|private|protected)/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Signal requires single-line JSDoc (/** description */).'
          });
        } else if (!jsDocInfo.isSingleLine) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **JSDoc Standard**: Signal should have single-line JSDoc, not multi-line.'
          });
        }

        if (!hasAccess) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Signal missing access modifier (public/private/protected).'
          });
        }
      }

      // Check input properties
      if (inputRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const hasAccess = /(public|private|protected)/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Input property requires single-line JSDoc (/** description */).'
          });
        } else if (!jsDocInfo.isSingleLine) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **JSDoc Standard**: Input should have single-line JSDoc, not multi-line.'
          });
        }

        if (!hasAccess) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Input property missing access modifier (public/private/protected).'
          });
        }
      }

      // Check output properties
      if (outputRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const hasAccess = /(public|private|protected)/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: Output property requires single-line JSDoc (/** description */).'
          });
        } else if (!jsDocInfo.isSingleLine) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **JSDoc Standard**: Output should have single-line JSDoc, not multi-line.'
          });
        }

        if (!hasAccess) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: Output property missing access modifier (public/private/protected).'
          });
        }
      }

      // Check viewChild properties
      if (viewChildRegex.test(line) && isNearChangedLine(lineNum, changedRanges)) {
        const jsDocInfo = getJsDocInfo(lines, index);
        const hasAccess = /(public|private|protected)/.test(line);

        if (!jsDocInfo.exists) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Missing JSDoc**: ViewChild property requires single-line JSDoc (/** description */).'
          });
        } else if (!jsDocInfo.isSingleLine) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **JSDoc Standard**: ViewChild should have single-line JSDoc, not multi-line.'
          });
        }

        if (!hasAccess) {
          comments.push({
            path: file,
            line: lineNum,
            body: '📚 **Code Standard**: ViewChild property missing access modifier (public/private/protected).'
          });
        }
      }
    });
  } catch (error) {
    console.error(`Error reading ${file}: ${error.message}`);
  }

  return comments;
}

// ============================================================================
// CSS File Checker (Enhanced from check-tailwind-standards.js)
// ============================================================================

/**
 * Checks CSS files for Tailwind standard violations on changed lines
 * @param {string} file - Path to the CSS file to check
 * @param {Array<{start: number, end: number}>} changedRanges - Array of changed line ranges from git diff
 * @returns {Array<{path: string, line: number, body: string}>} Array of violation comments for PR review
 */
function checkCSSFile(file, changedRanges) {
  const comments = [];
  
  // Get all violations from the tailwind checker
  const violations = checkCSSFileFromTailwind(file);
  
  // Filter to only changed lines and transform to comment format
  violations.forEach((violation) => {
    if (!isLineChanged(violation.line, changedRanges)) return;
    
    // Transform violation into PR comment format
    const emoji = violation.severity === 'error' ? '❌' : '🎨';
    const label = violation.severity === 'error' ? 'CSS Standard (STRICT)' : 'CSS Standard';
    
    comments.push({
      path: file,
      line: violation.line,
      body: `${emoji} **${label}**: ${violation.message}`
    });
  });
  
  return comments;
}

// ============================================================================
// Main Execution
// ============================================================================

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

// Exit 0 so output is captured properly
process.exit(0);
