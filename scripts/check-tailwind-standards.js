/**
 * Tailwind Standards Checker
 * Validates CSS files for Tailwind compliance and flags hardcoded values
 * Checks for properties that should use Tailwind utilities or design tokens
 */

const fs = require('fs');
const path = require('path');

// CSS properties that have direct Tailwind equivalents
const TAILWIND_PROPERTIES = {
  // Colors
  'color': { tailwind: 'text-{color}', category: 'color', strict: true },
  'background-color': { tailwind: 'bg-{color}', category: 'color', strict: true },
  'border-color': { tailwind: 'border-{color}', category: 'color', strict: true },
  
  // Spacing
  'margin': { tailwind: 'm-{size}', category: 'spacing' },
  'margin-top': { tailwind: 'mt-{size}', category: 'spacing' },
  'margin-right': { tailwind: 'mr-{size}', category: 'spacing' },
  'margin-bottom': { tailwind: 'mb-{size}', category: 'spacing' },
  'margin-left': { tailwind: 'ml-{size}', category: 'spacing' },
  'padding': { tailwind: 'p-{size}', category: 'spacing' },
  'padding-top': { tailwind: 'pt-{size}', category: 'spacing' },
  'padding-right': { tailwind: 'pr-{size}', category: 'spacing' },
  'padding-bottom': { tailwind: 'pb-{size}', category: 'spacing' },
  'padding-left': { tailwind: 'pl-{size}', category: 'spacing' },
  
  // Sizing
  'width': { tailwind: 'w-{size}', category: 'sizing' },
  'height': { tailwind: 'h-{size}', category: 'sizing' },
  'min-width': { tailwind: 'min-w-{size}', category: 'sizing' },
  'min-height': { tailwind: 'min-h-{size}', category: 'sizing' },
  'max-width': { tailwind: 'max-w-{size}', category: 'sizing' },
  'max-height': { tailwind: 'max-h-{size}', category: 'sizing' },
  
  // Borders
  'border': { tailwind: 'border border-{color}', category: 'border' },
  'border-radius': { tailwind: 'rounded-{size}', category: 'border' },
  'border-width': { tailwind: 'border-{width}', category: 'border' },
  
  // Display
  'display': { tailwind: 'block|flex|grid|hidden|inline', category: 'display' },
  'flex-direction': { tailwind: 'flex-row|flex-col', category: 'flexbox' },
  'justify-content': { tailwind: 'justify-{align}', category: 'flexbox' },
  'align-items': { tailwind: 'items-{align}', category: 'flexbox' },
  'flex-wrap': { tailwind: 'flex-wrap|flex-nowrap', category: 'flexbox' },
  'gap': { tailwind: 'gap-{size}', category: 'spacing' },
  
  // Text
  'font-size': { tailwind: 'text-{size}', category: 'text' },
  'font-weight': { tailwind: 'font-{weight}', category: 'text' },
  'font-family': { tailwind: 'font-{family}', category: 'text', strict: true },
  'line-height': { tailwind: 'leading-{size}', category: 'text' },
  'text-align': { tailwind: 'text-{align}', category: 'text' },
  
  // Effects
  'opacity': { tailwind: 'opacity-{value}', category: 'effects' },
  'box-shadow': { tailwind: 'shadow-{size}', category: 'effects' },
};

// Properties that are exempt from Tailwind enforcement
const EXEMPT_PROPERTIES = [
  'animation',
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'transform',
  'transform-origin',
  'perspective',
  'perspective-origin',
  'backface-visibility',
  'clip-path',
  'mask',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'z-index',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'pointer-events',
  'user-select',
  'cursor',
  'list-style',
  'content',
  'counter-reset',
  'counter-increment',
  'quotes',
  'writing-mode',
  'direction',
  'overflow',
  'overflow-x',
  'overflow-y',
  'white-space',
  'word-break',
  'hyphens',
  'text-transform',
  'text-decoration',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-shadow',
  'letter-spacing',
  'word-spacing',
  'font-style',
  'font-variant',
  'font-feature-settings',
  'outline',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
];

// Patterns for hardcoded values that should use Tailwind
const HARDCODED_PATTERNS = {
  HEX_COLOR: /^#[0-9A-Fa-f]{3,6}$/,
  RGB_COLOR: /^rgb\(/i,
  RGBA_COLOR: /^rgba\(/i,
  HSL_COLOR: /^hsl\(/i,
  NAMED_COLOR: /^(red|blue|green|yellow|purple|orange|pink|white|black|gray|grey|brown|navy|teal|cyan|magenta|lime|maroon|khaki|salmon|coral|gold|silver|bronze)$/i,
  HARDCODED_FONT: /^(Arial|Helvetica|Times New Roman|Georgia|Verdana|Courier|Comic Sans|Impact|Trebuchet MS|Palatino|Garamond|Bookman|Tahoma|Lucida|Sans-serif|Serif|Monospace)$/i,
};

/**
 * Checks a CSS file for Tailwind standard violations
 * Flags hardcoded colors, fonts, and properties that have Tailwind equivalents
 * @param {string} filePath - Path to the CSS file to check
 * @returns {Array<{file: string, line: number, property: string, value: string, tailwind: string, category: string, severity: string, message: string}>} Array of violations found
 */
function checkCSSFile(filePath) {
  const fileViolations = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    let currentSelector = '';
    
    lines.forEach((line, lineIndex) => {
      const lineNum = lineIndex + 1;
      
      // Track current selector
      if (line.includes('{')) {
        currentSelector = line.split('{')[0].trim();
      }
      
      // Match CSS property: value patterns
      const propMatch = line.match(/^\s*([a-z-]+)\s*:\s*(.+?)(?:;|$)/);
      
      if (propMatch) {
        const property = propMatch[1];
        const value = propMatch[2].trim();
        
        // Skip exempt properties
        if (EXEMPT_PROPERTIES.includes(property)) {
          return;
        }
        
        // Check if property has Tailwind equivalent
        if (TAILWIND_PROPERTIES[property]) {
          const info = TAILWIND_PROPERTIES[property];
          
          // STRICT MODE: Flag hardcoded values for certain properties
          if (info.strict) {
            let hardcodedType = null;
            
            // Check for var() usage - require fallback for strict properties
            const varMatch = value.match(/^var\s*\(\s*([^)]+)\s*\)/);
            if (varMatch) {
              const varContent = varMatch[1];
              // Check if var() has a fallback (contains a comma)
              if (!varContent.includes(',')) {
                fileViolations.push({
                  file: filePath,
                  line: lineNum,
                  property: property,
                  value: value,
                  tailwind: info.tailwind,
                  category: info.category,
                  severity: 'error',
                  message: `STRICT: var() must include a fallback value. Example: var(--custom-color, theme('colors.accent.main'))`
                });
                return;
              }
              // Has fallback, allow it
              return;
            }
            
            // Allow theme() function
            if (/^theme\s*\(/.test(value)) {
              return; // Skip - using design tokens is acceptable
            }
            
            if (property === 'color' || property === 'background-color' || property === 'border-color') {
              // Check for hardcoded colors
              if (HARDCODED_PATTERNS.HEX_COLOR.test(value) || 
                  HARDCODED_PATTERNS.RGB_COLOR.test(value) ||
                  HARDCODED_PATTERNS.RGBA_COLOR.test(value) ||
                  HARDCODED_PATTERNS.HSL_COLOR.test(value) ||
                  HARDCODED_PATTERNS.NAMED_COLOR.test(value)) {
                hardcodedType = 'color';
              }
            } else if (property === 'font-family') {
              // Check for hardcoded font families
              if (HARDCODED_PATTERNS.HARDCODED_FONT.test(value)) {
                hardcodedType = 'font-family';
              }
            }
            
            if (hardcodedType) {
              fileViolations.push({
                file: filePath,
                line: lineNum,
                property: property,
                value: value,
                tailwind: info.tailwind,
                category: info.category,
                severity: 'error',
                message: `STRICT: Hardcoded ${hardcodedType} value '${value}' found. Must use Tailwind utilities or global variables.`
              });
              return;
            }
          }
          
          // Skip non-strict properties if using design tokens
          if (/^(theme|var)\s*\(/.test(value)) {
            return; // Allow theme() and var() for all properties
          }
          
          // Check if we're in a :host selector - suggest @apply format
          const isHostSelector = currentSelector.includes(':host');
          const suggestion = isHostSelector 
            ? `Use @apply ${info.tailwind}` 
            : `Use Tailwind '${info.tailwind}'`;
          
          // Regular check for any direct CSS property
          fileViolations.push({
            file: filePath,
            line: lineNum,
            property: property,
            value: value,
            tailwind: info.tailwind,
            category: info.category,
            severity: 'warning',
            isHostSelector: isHostSelector,
            message: `Property '${property}' should use ${suggestion}`
          });
        }
      }
    });
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error.message);
  }
  return fileViolations;
}

// Export configuration and functions for use in other scripts
module.exports = {
  checkCSSFile,
  TAILWIND_PROPERTIES,
  EXEMPT_PROPERTIES,
  HARDCODED_PATTERNS
};

// Only run CLI behavior if executed directly (not required as module)
if (require.main === module) {
  // CLI args
  const args = process.argv.slice(2);
  const explicitFiles = args.filter((a) => a.endsWith('.css'));

  if (explicitFiles.length === 0) {
    console.log('Usage: node scripts/check-tailwind-standards.js <file.css> [file2.css]...');
    process.exit(0);
  }
  
  let violations = [];
  
  // Process files
  explicitFiles.forEach((file) => {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      return;
    }
    violations = violations.concat(checkCSSFile(file));
  });

  // Report violations
  if (violations.length > 0) {
    const errors = violations.filter(v => v.severity === 'error');
    const warnings = violations.filter(v => v.severity === 'warning');
    
    errors.forEach((v) => {
      console.log(`❌ ${v.message}`);
      console.log(`   File: ${v.file}:${v.line}`);
      console.log(`   Property: ${v.property}: ${v.value}`);
      console.log(`   Suggestion: Use Tailwind '${v.tailwind}' or global variables instead`);
      console.log('');
    });
    
    warnings.forEach((v) => {
      console.log(`⚠️  ${v.message}`);
      console.log(`   File: ${v.file}:${v.line}`);
      console.log(`   Property: ${v.property}: ${v.value}`);
      console.log(`   Suggestion: Use '${v.tailwind}' instead`);
      console.log('');
    });
    
    console.log(`\n❌ Found ${errors.length} error(s) and ${warnings.length} warning(s).`);
    process.exit(1);
  } else {
    console.log('✅ No Tailwind compliance issues found!');
    process.exit(0);
  }
}

