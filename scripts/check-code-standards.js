/**
 * Code Standards Checker
 * Validates TypeScript files for JSDoc, access modifiers, return types, and Angular patterns
 * Can be run directly or imported as a module
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// Directories to skip when collecting files
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'build',
  '.git',
  '.angular',
  'out-tsc',
  '.cache'
]);

// CLI args
const args = process.argv.slice(2);
const explicitFiles = args.filter((a) => a.endsWith('.ts'));
const scanAll = args.includes('--all');
const staged = args.includes('--staged');
const changed = args.includes('--changed') || (!scanAll && explicitFiles.length === 0);
const diffArg = args.find((a) => a.startsWith('--diff='));
const diffRef = diffArg ? diffArg.split('=')[1] : null;

let files = explicitFiles.slice();

/**
 * Checks if the current directory is a git repository
 * @returns {boolean} True if inside a git repository
 */
function isGitRepo() {
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets list of changed TypeScript files from git
 * @param {Object} options - Options for determining which files changed
 * @param {boolean} [options.staged] - Get staged files only
 * @param {string} [options.ref] - Compare against a specific git reference
 * @returns {string[]} Array of file paths that were changed
 */
function getChangedFiles({ staged, ref } = {}) {
  if (!isGitRepo()) return [];
  try {
    let output = '';
    if (staged) {
      output = cp.execSync('git diff --name-only --cached --diff-filter=ACMRTUXB', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } else if (ref) {
      // Compare provided ref to HEAD
      output = cp.execSync(`git diff --name-only --diff-filter=ACMRTUXB ${ref}...HEAD`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } else {
      // Use porcelain status for working tree changes
      output = cp.execSync('git status --porcelain', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      // Parse status lines -> filenames
      const lines = output.split(/\r?\n/).filter(Boolean);
      const paths = lines
        .map((l) => {
          // Examples: ' M libs/foo.ts', 'A  libs/foo.ts', '?? libs/foo.ts', 'R  old -> new'
          const trimmed = l.trim();
          if (trimmed.startsWith('R')) {
            const m = trimmed.match(/->\s*(.+)$/);
            return m ? m[1] : null;
          }
          const parts = trimmed.split(/\s+/);
          return parts[parts.length - 1] || null;
        })
        .filter(Boolean);
      return paths.filter((p) => p.endsWith('.ts'));
    }
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((p) => p.endsWith('.ts'));
  } catch {
    return [];
  }
}

/**
 * Recursively collects all TypeScript files from a directory
 * Skips common build/vendor directories like node_modules, dist, coverage
 * @param {string} dir - Directory path to scan
 * @returns {string[]} Array of TypeScript file paths
 */
function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

let hasError = false;

// ============================================================================
// Module-level Helper Functions (for export and use in checkFile)
// ============================================================================

/**
 * Detects whether a proper JSDoc block sits above a line
 * @param {string[]} lines - Array of file lines
 * @param {number} index - Line index to check above
 * @returns {{exists: boolean, isSingleLine: boolean, startIdx: number, endIdx: number, content: string}} JSDoc info object
 */
function getJsDocInfo(lines, index) {
    let j = index - 1;
    
    // Skip only ACTUAL decorators (like @HostListener, @Input which appear OUTSIDE comment blocks)
    // Do NOT skip JSDoc lines that contain @public, @param, @returns, etc.
    // Decorators appear as @DecoratorName(...) on their own lines, not as part of /**...*/ blocks
    while (j >= 0 && lines[j].trim() === '') j--; // Skip blank lines first
    
    // Now skip TypeScript/Angular decorators only (must NOT contain /* or *)
    while (j >= 0 && /^\s*@[A-Z]\w+\s*[\({]/.test(lines[j])) {
      j--;
    }
    
    // Skip remaining blank lines
    while (j >= 0 && lines[j].trim() === '') j--;
    
    if (j < 0) return { exists: false, isSingleLine: false, startIdx: -1, endIdx: -1, content: '' };

    const line = lines[j];

    // Single-line JSDoc on one line
    if (/^\s*\/\*\*.*\*\/\s*$/.test(line)) {
      return { exists: true, isSingleLine: true, startIdx: j, endIdx: j, content: line };
    }

    // If we are at the end or middle of a block, walk back to find /**
    if (/^\s*\*\/\s*$/.test(line) || /^\s*\*\s*/.test(line)) {
      const endIdx = j;
      while (j >= 0) {
        if (/^\s*\/\*\*/.test(lines[j])) {
          // Found JSDoc start
          const content = lines.slice(j, endIdx + 1).join('\n');
          return { exists: true, isSingleLine: false, startIdx: j, endIdx, content };
        }
        // Encountered a non-Javadoc block start
        if (/^\s*\/\*/.test(lines[j]) && !/^\s*\/\*\*/.test(lines[j])) {
          return { exists: false, isSingleLine: false, startIdx: -1, endIdx: -1, content: '' };
        }
        j--;
      }
      return { exists: false, isSingleLine: false, startIdx: -1, endIdx: -1, content: '' };
    }

    // Directly above is the start of JSDoc (single line that continues)
    if (/^\s*\/\*\*/.test(line)) {
      // Check if it's a single line or start of multi-line
      if (/^\s*\/\*\*.*\*\/\s*$/.test(line)) {
        return { exists: true, isSingleLine: true, startIdx: j, endIdx: j, content: line };
      }
      // Multi-line that starts with /** and continues
      let endIdx = j;
      while (endIdx < lines.length && !/\*\/\s*$/.test(lines[endIdx])) endIdx++;
      const content = lines.slice(j, endIdx + 1).join('\n');
      return { exists: true, isSingleLine: false, startIdx: j, endIdx, content };
    }

    return { exists: false, isSingleLine: false, startIdx: -1, endIdx: -1, content: '' };
}

/**
 * Extracts function parameters from a method line
 * @param {string} line - The method declaration line
 * @returns {Array<{name: string, type: string}>} Array of parameter objects with name and type
 */
function extractParams(line) {
  const match = line.match(/\(([^)]*)\)/);
  if (!match) return [];
  const paramsStr = match[1].trim();
  if (!paramsStr) return [];
  // Split by comma, but handle generics (e.g., Array<string, number>)
  const params = [];
  let depth = 0;
  let current = '';
  for (const char of paramsStr) {
    if (char === '<' || char === '(' || char === '{') depth++;
    else if (char === '>' || char === ')' || char === '}') depth--;
    else if (char === ',' && depth === 0) {
      if (current.trim()) params.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) params.push(current.trim());
  // Extract param names and types
  return params.map(p => {
    // Handle destructuring like { x, y }: Point
    if (p.trim().startsWith('{')) {
      const destructMatch = p.match(/\}\s*:\s*(\S+)/);
      return { name: 'destructured', type: destructMatch ? destructMatch[1] : 'unknown' };
    }
    const parts = p.split(':');
    let name = parts[0].trim().replace(/^\?/, '').replace(/\?$/, ''); // Remove optional markers
    let type = parts[1] ? parts[1].split('=')[0].trim() : 'unknown';
    return { name, type };
  }).filter(p => p.name);
}

/**
 * Extracts the access modifier from a code line
 * @param {string} line - The code line to parse
 * @returns {string|null} The access modifier (public/private/protected) or null if none
 */
function getAccessModifier(line) {
  const match = line.match(/^\s*(public|private|protected)\s/);
  return match ? match[1] : null;
}

/**
 * Validates that JSDoc access modifier tag matches the actual code modifier
 * @param {string} jsDocContent - The JSDoc comment content
 * @param {string|null} actualModifier - The actual access modifier from code
 * @returns {{valid: boolean, message: string}} Validation result with error message if invalid
 */
function checkAccessModifierTag(jsDocContent, actualModifier) {
  if (!actualModifier) return { valid: true, message: '' }; // No modifier on line, skip this check
  
  const hasPublicTag = /@public\b/.test(jsDocContent);
  const hasPrivateTag = /@private\b/.test(jsDocContent);
  const hasProtectedTag = /@protected\b/.test(jsDocContent);
  
  const tagCount = [hasPublicTag, hasPrivateTag, hasProtectedTag].filter(Boolean).length;
  
  if (tagCount === 0) {
    return { valid: false, message: `Missing @${actualModifier} tag in JSDoc` };
  }
  if (tagCount > 1) {
    return { valid: false, message: 'Multiple access modifier tags in JSDoc' };
  }
  
  if (actualModifier === 'public' && !hasPublicTag) {
    return { valid: false, message: `JSDoc should have @public (method is public)` };
  }
  if (actualModifier === 'private' && !hasPrivateTag) {
    return { valid: false, message: `JSDoc should have @private (method is private)` };
  }
  if (actualModifier === 'protected' && !hasProtectedTag) {
    return { valid: false, message: `JSDoc should have @protected (method is protected)` };
  }
  
  return { valid: true, message: '' };
}

/**
 * Checks if JSDoc contains a @returns or @return tag
 * @param {string} jsDocContent - The JSDoc comment content
 * @returns {boolean} True if @returns or @return tag is present
 */
function hasReturnsTag(jsDocContent) {
  return /@returns?\s|\@returns?\s*$/m.test(jsDocContent);
}

/**
 * Validates that JSDoc @param tags match function parameters
 * @param {string} jsDocContent - The JSDoc comment content
 * @param {Array<{name: string, type: string}>} params - Array of function parameters
 * @returns {{valid: boolean, errors: string[]}} Validation result with array of error messages
 */
function checkParamTags(jsDocContent, params) {
  if (params.length === 0) return { valid: true, errors: [] };
  
  const errors = [];
  
  for (const param of params) {
    // Skip destructured params - they're complex to validate
    if (param.name === 'destructured') continue;
    
    // Check if @param exists for this param name
    const paramNameRegex = new RegExp(`@param\\s+(\\{[^}]*\\})?\\s*\\[?${param.name}\\]?[\\s\\-]`, 'i');
    const paramMatch = jsDocContent.match(paramNameRegex);
    
    if (!paramMatch) {
      errors.push(`Missing @param for '${param.name}'`);
      continue;
    }
    
    // Check if @param has {Type} in curly braces
    const hasTypeInBraces = paramMatch[1] && paramMatch[1].length > 2; // More than just {}
    if (!hasTypeInBraces) {
      errors.push(`@param ${param.name} missing {Type} in curly braces`);
    }
  }
  
  // Also check for extra @param tags that don't match any actual params
  const jsDocParamNames = [...jsDocContent.matchAll(/@param\s*(?:\{[^}]*\})?\s*\[?(\w+)\]?/g)].map(m => m[1]);
  const actualParamNames = params.filter(p => p.name !== 'destructured').map(p => p.name);
  
  for (const docParam of jsDocParamNames) {
    if (!actualParamNames.includes(docParam)) {
      errors.push(`Extra @param '${docParam}' in JSDoc doesn't match any function parameter`);
    }
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Validates that a property has proper single-line JSDoc format
 * @param {Object} jsDocInfo - JSDoc info object from getJsDocInfo
 * @param {string} propertyType - Type of property being checked (for error messages)
 * @returns {string[]} Array of error messages if violations found
 */
function checkSingleLineJsDoc(jsDocInfo, propertyType) {
  const errors = [];
  
  if (!jsDocInfo.isSingleLine) {
    errors.push(`${propertyType} should have single-line JSDoc (/** ... */), not multi-line`);
  }
  
  // Check that single-line JSDoc has actual content (not just /** */)
  if (jsDocInfo.isSingleLine) {
    const content = jsDocInfo.content.replace(/\/\*\*|\*\//g, '').trim();
    if (!content) {
      errors.push(`${propertyType} JSDoc is empty - add a description`);
    }
  }
  
  return errors;
}

// ============================================================================
// File Checking
// ============================================================================

/**
 * Checks a TypeScript file for code standard violations
 * Validates JSDoc, access modifiers, return types, and Angular patterns
 * @param {string} file - Path to the TypeScript file to check
 * @param {boolean} logErrors - Whether to log errors to console (default: true for CLI, false for programmatic use)
 * @returns {{hasError: boolean, violations: Array}} Object with error status and violations array
 */
function checkFile(file, logErrors = true) {
  const violations = [];
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  // Simple regex for top-level method/function definitions in a class
  const methodRegex =
    /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*\([^)]*\)\s*:\s*[A-Za-z0-9_[\]|<>]+[ \t]*\{/;

  // Angular Signals - more specific
  const computedRegex = /^[ \t]*(public|private|protected)[ \t]+(readonly[ \t]+)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*computed\s*[<(]/;
  const signalRegex = /^[ \t]*(public|private|protected)[ \t]+(readonly[ \t]+)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*signal\s*[<(]/;
  const inputRegex = /^[ \t]*(public|private|protected)[ \t]+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*input(\.required)?\s*[<(]/;
  const outputRegex = /^[ \t]*(public|private|protected)[ \t]+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*output\s*[<(]/;
  const viewChildRegex = /^[ \t]*(public|private|protected)[ \t]+(readonly[ \t]+)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*viewChild(\.required)?\s*[<(]/;

  /**
   * Helper to log and track violations
   */
  function addViolation(message, line) {
    violations.push({ file, line, message });
    if (logErrors) {
      console.error(`❌ ${message} at ${file}:${line}`);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check methods/functions
    if (methodRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);

      // ✅ Check access modifier on the code line
      const actualModifier = getAccessModifier(line);
      const hasAccess = actualModifier !== null;

      // ✅ Check return type (already guaranteed by regex but double-check)
      const hasReturnType = /:\s*[A-Za-z0-9_[\]|<>]+/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above method', i + 1);
      } else {
        // Check for @returns tag in JSDoc
        if (!hasReturnsTag(jsDocInfo.content)) {
          addViolation('Missing @returns in JSDoc', i + 1);
        }
        
        // Check @public/@private/@protected matches actual access modifier
        const accessCheck = checkAccessModifierTag(jsDocInfo.content, actualModifier);
        if (!accessCheck.valid) {
          addViolation(accessCheck.message, i + 1);
        }
        
        // Check for @param {Type} tags with correct names
        const params = extractParams(line);
        const paramCheck = checkParamTags(jsDocInfo.content, params);
        if (!paramCheck.valid) {
          for (const err of paramCheck.errors) {
            addViolation(err, i + 1);
          }
        }
      }

      if (!hasAccess) {
        addViolation('Missing access modifier on method', i + 1);
      }

      if (!hasReturnType) {
        addViolation('Missing return type', i + 1);
      }
    }

    // Check computed properties
    if (computedRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above computed property', i + 1);
      } else {
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Computed property');
        for (const err of singleLineErrors) {
          addViolation(err, i + 1);
        }
      }
      if (!hasAccess) {
        addViolation('Missing access modifier on computed property', i + 1);
      }
    }

    // Check signal properties
    if (signalRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above signal', i + 1);
      } else {
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Signal');
        for (const err of singleLineErrors) {
          addViolation(err, i + 1);
        }
      }
      if (!hasAccess) {
        addViolation('Missing access modifier on signal', i + 1);
      }
    }

    // Check input properties
    if (inputRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above input', i + 1);
      } else {
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Input');
        for (const err of singleLineErrors) {
          addViolation(err, i + 1);
        }
      }
      if (!hasAccess) {
        addViolation('Missing access modifier on input', i + 1);
      }
    }

    // Check output properties
    if (outputRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above output', i + 1);
      } else {
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Output');
        for (const err of singleLineErrors) {
          addViolation(err, i + 1);
        }
      }
      if (!hasAccess) {
        addViolation('Missing access modifier on output', i + 1);
      }
    }

    // Check viewChild properties
    if (viewChildRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(lines, i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        addViolation('Missing JSDoc above viewChild', i + 1);
      } else {
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'ViewChild');
        for (const err of singleLineErrors) {
          addViolation(err, i + 1);
        }
      }
      if (!hasAccess) {
        addViolation('Missing access modifier on viewChild', i + 1);
      }
    }
  }
  
  return { hasError: violations.length > 0, violations };
}

// Export functions for use in other scripts
module.exports = {
  getJsDocInfo,
  extractParams,
  getAccessModifier,
  checkAccessModifierTag,
  hasReturnsTag,
  checkParamTags,
  checkSingleLineJsDoc,
  checkFile
};

// Only run CLI behavior if executed directly (not required as module)
if (require.main === module) {
  let hasError = false;
  
  // Determine source roots in Nx-style monorepos: src/, apps/*/src, libs/*/src
  if (files.length === 0) {
    if (changed && isGitRepo()) {
      files = getChangedFiles({ staged, ref: diffRef });
      if (files.length === 0) {
        console.log('ℹ️ No changed TypeScript files detected.');
        process.exit(0);
      }
    } else if (scanAll) {
      console.log('🔍 Scanning source directories for TypeScript files...');

      const sourceDirs = [];

      // Top-level src
      const rootSrc = path.join(process.cwd(), 'src');
      if (fs.existsSync(rootSrc)) sourceDirs.push(rootSrc);

      // apps/*/src
      const appsRoot = path.join(process.cwd(), 'apps');
      if (fs.existsSync(appsRoot)) {
        for (const entry of fs.readdirSync(appsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const appSrc = path.join(appsRoot, entry.name, 'src');
          if (fs.existsSync(appSrc)) sourceDirs.push(appSrc);
        }
      }

      // libs/*/src
      const libsRoot = path.join(process.cwd(), 'libs');
      if (fs.existsSync(libsRoot)) {
        for (const entry of fs.readdirSync(libsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const libSrc = path.join(libsRoot, entry.name, 'src');
          if (fs.existsSync(libSrc)) sourceDirs.push(libSrc);
        }
      }

      // projects/*/src (Angular workspace structure)
      const projectsRoot = path.join(process.cwd(), 'projects');
      if (fs.existsSync(projectsRoot)) {
        for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          // Check projects/*/src
          const projectSrc = path.join(projectsRoot, entry.name, 'src');
          if (fs.existsSync(projectSrc)) sourceDirs.push(projectSrc);
          // Also check nested like projects/ntv360/component-pantry/src
          const nestedPath = path.join(projectsRoot, entry.name);
          for (const nested of fs.readdirSync(nestedPath, { withFileTypes: true })) {
            if (!nested.isDirectory()) continue;
            const nestedSrc = path.join(nestedPath, nested.name, 'src');
            if (fs.existsSync(nestedSrc)) sourceDirs.push(nestedSrc);
          }
        }
      }

      // Collect TypeScript files from discovered source directories
      for (const dir of sourceDirs) {
        files.push(...collectFiles(dir));
      }

      if (files.length === 0) {
        console.log('ℹ️ No source directories found. Provide file paths as args.');
        process.exit(0);
      }
      
      console.log(`📁 Found ${files.length} TypeScript files to check.`);
    } else {
      console.log('ℹ️ Provide file paths, use --changed/--staged, or pass --all to scan sources.');
      process.exit(0);
    }
  }

  files.forEach(file => {
    const result = checkFile(file, true); // true = log errors to console
    if (result.hasError) {
      hasError = true;
    }
  });

  if (hasError) {
    console.log('\n⚠️ Code standard violations found. Please fix and recommit.');
    process.exit(1);
  } else {
    console.log(
      '✅ All code complies with JSDoc, access modifier, and return type rules!'
    );
  }
}
