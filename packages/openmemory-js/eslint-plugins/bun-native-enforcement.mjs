/**
 * ESLint Plugin: Bun Native API Enforcement
 * 
 * This plugin enforces the use of Bun Native APIs over Node.js APIs
 * as per AGENTS.md guidelines for OpenMemory codebase.
 */

const bunNativeEnforcementPlugin = {
    meta: {
        name: "bun-native-enforcement",
        version: "1.0.0",
    },
    rules: {
        "no-node-fs": {
            meta: {
                type: "problem",
                docs: {
                    description: "Disallow Node.js fs module in favor of Bun.file()",
                    category: "Best Practices",
                    recommended: true,
                },
                fixable: "code",
                schema: [
                    {
                        type: "object",
                        properties: {
                            allowExceptions: {
                                type: "array",
                                items: { type: "string" },
                                description: "File patterns where node:fs is allowed"
                            }
                        },
                        additionalProperties: false
                    }
                ],
                messages: {
                    noNodeFs: "Use Bun.file() instead of Node.js fs module. See AGENTS.md for guidelines.",
                    noNodeFsSync: "Use async Bun.file() instead of synchronous fs operations for better performance.",
                    useCompatLayer: "If fs.ReadStream is required for dependencies, wrap in compatibility layer in src/utils/."
                }
            },
            create(context) {
                const options = context.options[0] || {};
                const allowExceptions = options.allowExceptions || [];
                const filename = context.getFilename();
                
                // Check if current file is in exception list
                const isException = allowExceptions.some(pattern => 
                    filename.includes(pattern) || filename.match(new RegExp(pattern))
                );
                
                return {
                    ImportDeclaration(node) {
                        const source = node.source.value;
                        
                        // Check for node:fs or fs imports
                        if (source === "node:fs" || source === "fs") {
                            if (isException) {
                                return; // Allow in exception files
                            }
                            
                            context.report({
                                node,
                                messageId: "noNodeFs",
                                fix(fixer) {
                                    // Suggest Bun.file() usage in comment
                                    return fixer.insertTextBefore(node, 
                                        "// TODO: Replace with Bun.file() - see AGENTS.md\n"
                                    );
                                }
                            });
                        }
                        
                        // Check for fs/promises
                        if (source === "node:fs/promises" || source === "fs/promises") {
                            if (isException) {
                                return;
                            }
                            
                            context.report({
                                node,
                                messageId: "noNodeFs",
                                fix(fixer) {
                                    return fixer.insertTextBefore(node, 
                                        "// TODO: Replace with Bun.file() - see AGENTS.md\n"
                                    );
                                }
                            });
                        }
                    },
                    
                    CallExpression(node) {
                        // Check for require('fs') or require('node:fs')
                        if (node.callee.name === "require" && 
                            node.arguments.length > 0 && 
                            node.arguments[0].type === "Literal") {
                            
                            const moduleName = node.arguments[0].value;
                            if ((moduleName === "fs" || moduleName === "node:fs" || 
                                 moduleName === "fs/promises" || moduleName === "node:fs/promises") && 
                                !isException) {
                                
                                context.report({
                                    node,
                                    messageId: "noNodeFs"
                                });
                            }
                        }
                        
                        // Check for synchronous fs operations
                        if (node.callee.type === "MemberExpression" && 
                            node.callee.object.name === "fs") {
                            
                            const methodName = node.callee.property.name;
                            if (methodName && methodName.endsWith("Sync") && !isException) {
                                context.report({
                                    node,
                                    messageId: "noNodeFsSync"
                                });
                            }
                        }
                    }
                };
            }
        },
        
        "prefer-bun-spawn": {
            meta: {
                type: "suggestion",
                docs: {
                    description: "Prefer Bun.spawn() over child_process",
                    category: "Best Practices",
                    recommended: true,
                },
                fixable: "code",
                schema: [],
                messages: {
                    preferBunSpawn: "Use Bun.spawn() instead of child_process for better performance and Bun compatibility."
                }
            },
            create(context) {
                return {
                    ImportDeclaration(node) {
                        const source = node.source.value;
                        
                        if (source === "child_process" || source === "node:child_process") {
                            context.report({
                                node,
                                messageId: "preferBunSpawn",
                                fix(fixer) {
                                    return fixer.insertTextBefore(node, 
                                        "// TODO: Replace with Bun.spawn() - see AGENTS.md\n"
                                    );
                                }
                            });
                        }
                    },
                    
                    CallExpression(node) {
                        if (node.callee.name === "require" && 
                            node.arguments.length > 0 && 
                            node.arguments[0].type === "Literal") {
                            
                            const moduleName = node.arguments[0].value;
                            if (moduleName === "child_process" || moduleName === "node:child_process") {
                                context.report({
                                    node,
                                    messageId: "preferBunSpawn"
                                });
                            }
                        }
                    }
                };
            }
        },
        
        "prefer-bun-env": {
            meta: {
                type: "suggestion",
                docs: {
                    description: "Prefer Bun.env over process.env",
                    category: "Best Practices",
                    recommended: true,
                },
                fixable: "code",
                schema: [],
                messages: {
                    preferBunEnv: "Use Bun.env instead of process.env for better Bun integration. Access via src/core/cfg.ts only."
                }
            },
            create(context) {
                return {
                    MemberExpression(node) {
                        // Check for process.env usage
                        if (node.object.name === "process" && 
                            node.property.name === "env") {
                            
                            const filename = context.getFilename();
                            
                            // Allow in cfg.ts as it's the designated place for env access
                            if (filename.includes("cfg.ts") || filename.includes("config")) {
                                return;
                            }
                            
                            context.report({
                                node,
                                messageId: "preferBunEnv",
                                fix(fixer) {
                                    return fixer.replaceText(node, "Bun.env");
                                }
                            });
                        }
                    }
                };
            }
        },
        
        "enforce-bun-file-patterns": {
            meta: {
                type: "suggestion",
                docs: {
                    description: "Enforce proper Bun.file() usage patterns",
                    category: "Best Practices",
                    recommended: true,
                },
                schema: [],
                messages: {
                    preferAsync: "Use async Bun.file() operations for better performance.",
                    useProperMethods: "Use Bun.file(path).text(), .json(), .arrayBuffer() methods instead of fs operations."
                }
            },
            create(context) {
                return {
                    CallExpression(node) {
                        // Look for Bun.file usage and suggest best practices
                        if (node.callee.type === "MemberExpression" && 
                            node.callee.object.name === "Bun" && 
                            node.callee.property.name === "file") {
                            
                            // This is good usage, no error needed
                            return;
                        }
                        
                        // Check for file operations that could use Bun.file
                        if (node.callee.type === "MemberExpression" && 
                            node.callee.object.name === "fs") {
                            
                            const methodName = node.callee.property.name;
                            if (["readFile", "writeFile", "stat", "exists"].includes(methodName)) {
                                context.report({
                                    node,
                                    messageId: "useProperMethods"
                                });
                            }
                        }
                    }
                };
            }
        }
    }
};

export default bunNativeEnforcementPlugin;