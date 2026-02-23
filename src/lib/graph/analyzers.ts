/**
 * Language-specific regex-based import/export analyzers.
 *
 * Each analyzer extracts imports and exports from source files using regex patterns.
 * No tree-sitter — keeps the CLI binary lightweight.
 */

import type { LanguageAnalyzer, RawImport, RawExport } from './types.js';

// ── TypeScript / JavaScript ─────────────────────────────────────

const typescriptAnalyzer: LanguageAnalyzer = {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // Static: import X from 'path'
        // Static: import { X } from 'path'
        // Static: import * as X from 'path'
        // Static: import 'path'
        const staticImportRe = /import\s+(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/g;
        let match: RegExpExecArray | null;
        while ((match = staticImportRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // Static: export { X } from 'path'
        const reExportRe = /export\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/g;
        while ((match = reExportRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // Dynamic: import('path') or require('path')
        const dynamicRe = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = dynamicRe.exec(content)) !== null) {
            // Avoid double-counting static imports captured as import('...')
            const existing = imports.find(i => i.raw === match![1] && i.kind === 'static');
            if (!existing) {
                imports.push({ raw: match[1], kind: 'dynamic' });
            }
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // export function name
        const funcRe = /export\s+(?:async\s+)?function\s+(\w+)/g;
        let match: RegExpExecArray | null;
        while ((match = funcRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'function' });
        }

        // export class name
        const classRe = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        // export const/let/var name
        const varRe = /export\s+(?:const|let|var)\s+(\w+)/g;
        while ((match = varRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'variable' });
        }

        // export interface name
        const interfaceRe = /export\s+(?:type|interface)\s+(\w+)/g;
        while ((match = interfaceRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'type' });
        }

        // export default (function/class/expression)
        const defaultRe = /export\s+default\s+(?:(?:async\s+)?function|class)?\s*(\w+)?/g;
        while ((match = defaultRe.exec(content)) !== null) {
            exports.push({ name: match[1] ?? 'default', kind: 'default' });
        }

        // export enum name
        const enumRe = /export\s+(?:const\s+)?enum\s+(\w+)/g;
        while ((match = enumRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'enum' });
        }

        return exports;
    },
};

// ── PHP ─────────────────────────────────────────────────────────

const phpAnalyzer: LanguageAnalyzer = {
    id: 'php',
    extensions: ['.php'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // use App\Models\User;
        // use App\Models\User as UserModel;
        const useRe = /^use\s+([A-Za-z\\]+(?:\s+as\s+\w+)?)\s*;/gm;
        let match: RegExpExecArray | null;
        while ((match = useRe.exec(content)) !== null) {
            const raw = match[1].replace(/\s+as\s+\w+$/, '').trim();
            imports.push({ raw, kind: 'static' });
        }

        // use function App\Helpers\str_slug;
        const useFuncRe = /^use\s+(?:function|const)\s+([A-Za-z\\]+)\s*;/gm;
        while ((match = useFuncRe.exec(content)) !== null) {
            imports.push({ raw: match[1].trim(), kind: 'static' });
        }

        // Group use: use App\Models\{User, Post};
        const groupUseRe = /^use\s+([A-Za-z\\]+)\\\{([^}]+)\}\s*;/gm;
        while ((match = groupUseRe.exec(content)) !== null) {
            const prefix = match[1];
            const names = match[2].split(',').map(n => n.trim().replace(/\s+as\s+\w+$/, ''));
            for (const name of names) {
                if (name) {
                    imports.push({ raw: `${prefix}\\${name}`, kind: 'static' });
                }
            }
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // class ClassName / final class / abstract class / readonly class
        const classRe = /(?:final\s+|abstract\s+|readonly\s+)*class\s+(\w+)/g;
        let match: RegExpExecArray | null;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        // interface InterfaceName
        const interfaceRe = /interface\s+(\w+)/g;
        while ((match = interfaceRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'interface' });
        }

        // trait TraitName
        const traitRe = /trait\s+(\w+)/g;
        while ((match = traitRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'trait' });
        }

        // enum EnumName
        const enumRe = /enum\s+(\w+)/g;
        while ((match = enumRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'enum' });
        }

        // public function name (top-level only — skip closures/lambdas via heuristic)
        const funcRe = /(?:public|protected|private)?\s*(?:static\s+)?function\s+(\w+)\s*\(/g;
        while ((match = funcRe.exec(content)) !== null) {
            if (match[1] !== '__construct') {
                exports.push({ name: match[1], kind: 'function' });
            }
        }

        return exports;
    },
};

// ── Python ──────────────────────────────────────────────────────

const pythonAnalyzer: LanguageAnalyzer = {
    id: 'python',
    extensions: ['.py'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // import module / import module.sub
        const importRe = /^import\s+([\w.]+)/gm;
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // from module import X / from module.sub import X, Y
        const fromRe = /^from\s+([\w.]+)\s+import\s+/gm;
        while ((match = fromRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // def function_name(
        const defRe = /^def\s+(\w+)\s*\(/gm;
        let match: RegExpExecArray | null;
        while ((match = defRe.exec(content)) !== null) {
            if (!match[1].startsWith('_')) {
                exports.push({ name: match[1], kind: 'function' });
            }
        }

        // class ClassName
        const classRe = /^class\s+(\w+)/gm;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        return exports;
    },
};

// ── Go ──────────────────────────────────────────────────────────

const goAnalyzer: LanguageAnalyzer = {
    id: 'go',
    extensions: ['.go'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // Single import: import "path"
        const singleRe = /import\s+"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = singleRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // Multi import: import ( "path1" \n "path2" )
        const multiRe = /import\s*\(([\s\S]*?)\)/g;
        while ((match = multiRe.exec(content)) !== null) {
            const block = match[1];
            const pathRe = /["']([^"']+)["']/g;
            let pathMatch: RegExpExecArray | null;
            while ((pathMatch = pathRe.exec(block)) !== null) {
                imports.push({ raw: pathMatch[1], kind: 'static' });
            }
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // func FunctionName(
        const funcRe = /^func\s+(\(?[A-Z]\w*)\s*\(/gm;
        let match: RegExpExecArray | null;
        while ((match = funcRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'function' });
        }

        // type TypeName struct/interface
        const typeRe = /^type\s+([A-Z]\w+)\s+(?:struct|interface)/gm;
        while ((match = typeRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'type' });
        }

        return exports;
    },
};

// ── Ruby ────────────────────────────────────────────────────────

const rubyAnalyzer: LanguageAnalyzer = {
    id: 'ruby',
    extensions: ['.rb'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // require 'path' / require "path"
        const requireRe = /require\s+['"]([^'"]+)['"]/g;
        let match: RegExpExecArray | null;
        while ((match = requireRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // require_relative 'path'
        const relRe = /require_relative\s+['"]([^'"]+)['"]/g;
        while ((match = relRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // class ClassName
        const classRe = /^class\s+(\w+)/gm;
        let match: RegExpExecArray | null;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        // module ModuleName
        const moduleRe = /^module\s+(\w+)/gm;
        while ((match = moduleRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'module' });
        }

        // def method_name
        const defRe = /^\s+def\s+(?:self\.)?(\w+)/gm;
        while ((match = defRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'function' });
        }

        return exports;
    },
};

// ── Rust ────────────────────────────────────────────────────────

const rustAnalyzer: LanguageAnalyzer = {
    id: 'rust',
    extensions: ['.rs'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // use crate::path; / use std::collections::HashMap;
        const useRe = /^use\s+([\w:]+(?:::\{[^}]+\})?)\s*;/gm;
        let match: RegExpExecArray | null;
        while ((match = useRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        // mod module_name;
        const modRe = /^mod\s+(\w+)\s*;/gm;
        while ((match = modRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // pub fn name(
        const funcRe = /pub\s+(?:async\s+)?fn\s+(\w+)/g;
        let match: RegExpExecArray | null;
        while ((match = funcRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'function' });
        }

        // pub struct Name / pub enum Name / pub trait Name
        const typeRe = /pub\s+(?:struct|enum|trait)\s+(\w+)/g;
        while ((match = typeRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'type' });
        }

        return exports;
    },
};

// ── Java ────────────────────────────────────────────────────────

const javaAnalyzer: LanguageAnalyzer = {
    id: 'java',
    extensions: ['.java'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // import com.example.package.ClassName;
        // import static com.example.ClassName.method;
        const importRe = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // public class/interface/enum/record ClassName
        const classRe = /(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+(\w+)/g;
        let match: RegExpExecArray | null;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        return exports;
    },
};

// ── C# ──────────────────────────────────────────────────────────

const csharpAnalyzer: LanguageAnalyzer = {
    id: 'csharp',
    extensions: ['.cs'],

    extractImports(content: string): RawImport[] {
        const imports: RawImport[] = [];

        // using Namespace.SubNamespace;
        // using static Namespace.ClassName;
        const usingRe = /^using\s+(?:static\s+)?([\w.]+)\s*;/gm;
        let match: RegExpExecArray | null;
        while ((match = usingRe.exec(content)) !== null) {
            imports.push({ raw: match[1], kind: 'static' });
        }

        return imports;
    },

    extractExports(content: string): RawExport[] {
        const exports: RawExport[] = [];

        // public class/interface/enum/struct/record ClassName
        const classRe = /(?:public|internal)\s+(?:partial\s+|abstract\s+|sealed\s+|static\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/g;
        let match: RegExpExecArray | null;
        while ((match = classRe.exec(content)) !== null) {
            exports.push({ name: match[1], kind: 'class' });
        }

        return exports;
    },
};

// ── Registry ────────────────────────────────────────────────────

const ALL_ANALYZERS: LanguageAnalyzer[] = [
    typescriptAnalyzer,
    phpAnalyzer,
    pythonAnalyzer,
    goAnalyzer,
    rubyAnalyzer,
    rustAnalyzer,
    javaAnalyzer,
    csharpAnalyzer,
];

const extensionMap = new Map<string, LanguageAnalyzer>();
for (const analyzer of ALL_ANALYZERS) {
    for (const ext of analyzer.extensions) {
        extensionMap.set(ext, analyzer);
    }
}

export function getAnalyzerForExtension(ext: string): LanguageAnalyzer | null {
    return extensionMap.get(ext) ?? null;
}

export function getAnalyzerForFile(filePath: string): LanguageAnalyzer | null {
    const dotIndex = filePath.lastIndexOf('.');
    if (dotIndex === -1) return null;
    const ext = filePath.slice(dotIndex).toLowerCase();
    return getAnalyzerForExtension(ext);
}

export function getSupportedExtensions(): string[] {
    return Array.from(extensionMap.keys());
}
