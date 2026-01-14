const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// CLI args
const args = process.argv.slice(2);
const explicitFiles = args.filter((a) => a.endsWith('.ts'));
const scanAll = args.includes('--all');
const staged = args.includes('--staged');
const changed = args.includes('--changed') || (!scanAll && explicitFiles.length === 0);
const diffArg = args.find((a) => a.startsWith('--diff='));
const diffRef = diffArg ? diffArg.split('=')[1] : null;

let files = explicitFiles.slice();

function isGitRepo() {
  try {
    cp.execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

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

// Recursively collect .ts files, skipping common build/vendor directories
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tmp', '.storybook']);
function collectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.stories.ts')) {
      out.push(full);
    }
  }
  return out;
}

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

let hasError = false;

function checkFile(file) {
  // Skip Storybook story files
  if (file.endsWith('.stories.ts')) {
    return;
  }

  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  // Detect whether a proper JSDoc block (/** ... */) sits above a line
  // Returns: { exists: boolean, isSingleLine: boolean, startIdx: number, endIdx: number }
  function getJsDocInfo(index) {
    let j = index - 1;
    // Skip blank lines and decorators (e.g., @HostListener, @Input, etc.)
    while (j >= 0 && (lines[j].trim() === '' || /^\s*@\w+/.test(lines[j]))) j--;
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

  // Legacy wrapper for backward compatibility
  function hasJsDocAbove(index) {
    return getJsDocInfo(index).exists;
  }

  // Simple regex for top-level method/function definitions in a class
  const methodRegex =
    /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*\([^)]*\)\s*:\s*[A-Za-z0-9_[\]|<>]+[ \t]*\{/;

  // Regex patterns for Angular signals, computed, inputs, outputs
  const computedRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*computed\s*[<(]/;
  const signalRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*signal\s*[<(]/;
  const inputRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*=\s*input(\.required)?\s*[<(]/;
  const outputRegex = /^[ \t]*(public|private|protected)?[ \t]*[a-zA-Z0-9_]+\s*=\s*output\s*[<(]/;
  const viewChildRegex = /^[ \t]*(public|private|protected)?[ \t]*(readonly)?[ \t]*[a-zA-Z0-9_]+\s*=\s*viewChild(\.required)?\s*[<(]/;

  // Helper to extract function parameters from a method line
  // Returns array of { name: string, type: string }
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

  // Helper to extract the access modifier from the code line
  function getAccessModifier(line) {
    const match = line.match(/^\s*(public|private|protected)\s/);
    return match ? match[1] : null;
  }

  // Helper to check if JSDoc has the correct @public/@private/@protected tag
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

  // Helper to check if JSDoc contains @returns
  function hasReturnsTag(jsDocContent) {
    return /@returns?\s/.test(jsDocContent);
  }

  // Helper to check if JSDoc contains @param {Type} for each parameter with correct names
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

  // Check if a property should have single-line JSDoc
  function checkSingleLineJsDoc(jsDocInfo, propertyType, file, lineNum) {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check methods/functions
    if (methodRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);

      // ✅ Check access modifier on the code line
      const actualModifier = getAccessModifier(line);
      const hasAccess = actualModifier !== null;

      // ✅ Check return type (already guaranteed by regex but double-check)
      const hasReturnType = /:\s*[A-Za-z0-9_[\]|<>]+/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above method at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check for @returns tag in JSDoc
        if (!hasReturnsTag(jsDocInfo.content)) {
          console.error(`❌ Missing @returns in JSDoc at ${file}:${i + 1}`);
          hasError = true;
        }
        
        // Check @public/@private/@protected matches actual access modifier
        const accessCheck = checkAccessModifierTag(jsDocInfo.content, actualModifier);
        if (!accessCheck.valid) {
          console.error(`❌ ${accessCheck.message} at ${file}:${i + 1}`);
          hasError = true;
        }
        
        // Check for @param {Type} tags with correct names
        const params = extractParams(line);
        const paramCheck = checkParamTags(jsDocInfo.content, params);
        if (!paramCheck.valid) {
          for (const err of paramCheck.errors) {
            console.error(`❌ ${err} at ${file}:${i + 1}`);
            hasError = true;
          }
        }
      }

      if (!hasAccess) {
        console.error(`❌ Missing access modifier on method at ${file}:${i + 1}`);
        hasError = true;
      }

      if (!hasReturnType) {
        console.error(`❌ Missing return type at ${file}:${i + 1}`);
        hasError = true;
      }
    }

    // Check computed properties
    if (computedRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above computed property at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check it's a single-line JSDoc
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Computed property');
        for (const err of singleLineErrors) {
          console.error(`❌ ${err} at ${file}:${i + 1}`);
          hasError = true;
        }
      }
      if (!hasAccess) {
        console.error(`❌ Missing access modifier on computed property at ${file}:${i + 1}`);
        hasError = true;
      }
    }

    // Check signal properties
    if (signalRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above signal at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check it's a single-line JSDoc
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Signal');
        for (const err of singleLineErrors) {
          console.error(`❌ ${err} at ${file}:${i + 1}`);
          hasError = true;
        }
      }
      if (!hasAccess) {
        console.error(`❌ Missing access modifier on signal at ${file}:${i + 1}`);
        hasError = true;
      }
    }

    // Check input properties
    if (inputRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above input at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check it's a single-line JSDoc
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Input');
        for (const err of singleLineErrors) {
          console.error(`❌ ${err} at ${file}:${i + 1}`);
          hasError = true;
        }
      }
      if (!hasAccess) {
        console.error(`❌ Missing access modifier on input at ${file}:${i + 1}`);
        hasError = true;
      }
    }

    // Check output properties
    if (outputRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above output at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check it's a single-line JSDoc
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'Output');
        for (const err of singleLineErrors) {
          console.error(`❌ ${err} at ${file}:${i + 1}`);
          hasError = true;
        }
      }
      if (!hasAccess) {
        console.error(`❌ Missing access modifier on output at ${file}:${i + 1}`);
        hasError = true;
      }
    }

    // Check viewChild properties
    if (viewChildRegex.test(line)) {
      const jsDocInfo = getJsDocInfo(i);
      const hasAccess = /(public|private|protected)/.test(line);

      if (!jsDocInfo.exists) {
        console.error(`❌ Missing JSDoc above viewChild at ${file}:${i + 1}`);
        hasError = true;
      } else {
        // Check it's a single-line JSDoc
        const singleLineErrors = checkSingleLineJsDoc(jsDocInfo, 'ViewChild');
        for (const err of singleLineErrors) {
          console.error(`❌ ${err} at ${file}:${i + 1}`);
          hasError = true;
        }
      }
      if (!hasAccess) {
        console.error(`❌ Missing access modifier on viewChild at ${file}:${i + 1}`);
        hasError = true;
      }
    }
  }
}

files.forEach(checkFile);

if (hasError) {
  console.log('\n⚠️ Code standard violations found. Please fix and recommit.');
  process.exit(1);
} else {
  console.log(
    '✅ All code complies with JSDoc, access modifier, and return type rules!'
  );
}
