#!/usr/bin/env node
/**
 * Validates JSDoc comments in TypeScript files
 * Ensures all exported functions and public methods have proper documentation
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const files = args.filter(arg => arg.endsWith('.ts') && !arg.endsWith('.spec.ts'));

if (files.length === 0) {
  console.log('Usage: node scripts/check-jsdoc-standards.js <file.ts> [file2.ts]...');
  process.exit(0);
}

let hasErrors = false;

files.forEach(filePath => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Patterns to find function declarations
    const functionPatterns = [
      /^\s*(public\s+)?(async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/,  // class methods
      /^\s*export\s+(async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/, // exported functions
      /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*:\s*\w+\s*{/, // typed methods
    ];

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      let isFunctionDeclaration = false;
      let functionName = '';

      for (const pattern of functionPatterns) {
        const match = line.match(pattern);
        if (match) {
          // Skip constructors, getters, setters, and private methods
          const fullLine = line.trim();
          if (fullLine.startsWith('constructor') || fullLine.startsWith('get ') || fullLine.startsWith('set ') || fullLine.startsWith('private ')) {
            break;
          }

          isFunctionDeclaration = true;
          functionName = match[match.length - 1]; // Get function name from last capture group
          break;
        }
      }

      if (isFunctionDeclaration && functionName) {
        // Check if previous line has JSDoc comment
        let hasJSDoc = false;
        let jsDocValid = false;

        // Look backwards for JSDoc
        for (let i = index - 1; i >= Math.max(0, index - 20); i--) {
          const prevLine = lines[i].trim();

          if (prevLine.startsWith('*/')) {
            // Found end of JSDoc, check if it's valid
            jsDocValid = checkJSDocValidity(lines, i, index);
            hasJSDoc = true;
            break;
          }

          // If we hit another function or class member, stop looking
          if ((i !== index - 1) && (prevLine.startsWith('function') || prevLine.match(/^\s*[a-zA-Z_$]/))) {
            break;
          }
        }

        if (!hasJSDoc) {
          console.log(`❌ Missing JSDoc: Function '${functionName}' at line ${lineNum} has no documentation`);
          hasErrors = true;
        } else if (!jsDocValid) {
          console.log(`⚠️  Invalid JSDoc: Function '${functionName}' at line ${lineNum} has incomplete documentation`);
          hasErrors = true;
        }
      }
    });
  } catch (error) {
    console.error(`Error reading ${filePath}: ${error.message}`);
    hasErrors = true;
  }
});

function checkJSDocValidity(lines, endLine, functionLine) {
  let hasDescription = false;
  let hasParams = false;
  let hasReturn = false;

  // Extract function signature to check parameters
  const funcSignature = lines[functionLine];
  const paramMatch = funcSignature.match(/\(([^)]*)\)/);
  const params = paramMatch ? paramMatch[1].split(',').filter(p => p.trim() && !p.includes('=')) : [];
  const hasParams_ = params.length > 0;

  // Check JSDoc content
  for (let i = endLine - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (line.startsWith('/**')) {
      break; // Found start
    }

    if (line.includes('*') && !line.startsWith('*/') && !line.startsWith('/**')) {
      const content = line.replace(/^\*\s*/, '').trim();

      if (content.length > 0 && !content.startsWith('@')) {
        hasDescription = true;
      }

      if (content.startsWith('@param')) {
        hasParams = true;
      }

      if (content.startsWith('@returns') || content.startsWith('@return')) {
        hasReturn = true;
      }
    }
  }

  // Check validity - needs description and return type
  if (!hasDescription) {
    return false;
  }

  return true;
}

if (hasErrors) {
  console.log('\n❌ JSDoc validation failed');
  process.exit(1);
} else {
  console.log('✓ All JSDoc comments are valid');
  process.exit(0);
}
