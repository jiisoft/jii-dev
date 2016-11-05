const fs = require('fs');
const esprima = require('esprima');
const escodegen = require('escodegen');
const esformatter = require('esformatter');
const glob = require('glob');

const processFile = function (path) {
    const defaultConstructor = {
        "type": "ExpressionStatement",
        "expression": {
            "type": "CallExpression",
            "callee": {"type": "Super"},
            "arguments": [{
                "type": "SpreadElement",
                "argument": {"type": "Identifier", "name": "arguments"}
            }]
        }
    };

    const classBodyAst = [
        {
            "type": "MethodDefinition",
            "key": {"type": "Identifier", "name": "constructor"},
            "computed": false,
            "value": {
                "type": "FunctionExpression",
                "id": null,
                "params": [],
                "body": {
                    "type": "BlockStatement",
                    "body": [defaultConstructor]
                },
                "generator": false,
                "expression": false
            },
            "kind": "constructor",
            "static": false
        }
    ];
    const classAst = {
        "type": "Program",
        "body": [{
            "type": "ExpressionStatement",
            "expression": {
                "type": "AssignmentExpression",
                "operator": "=",
                "left": {
                    "type": "MemberExpression",
                    "computed": false,
                    "object": {"type": "Identifier", "name": "module"},
                    "property": {"type": "Identifier", "name": "exports"}
                },
                "right": {
                    "type": "ClassExpression",
                    "id": {"type": "Identifier", "name": "Foo"},
                    "superClass": {"type": "Identifier", "name": "Bar"},
                    "body": {
                        "type": "ClassBody",
                        "body": classBodyAst
                    }
                }
            }
        }],
        "sourceType": "script",
        "comments": []
    };

    let content = fs.readFileSync(path).toString();
    content = content.replace(/\t/g, '    ');

    let ast = esprima.parse(content, {
        range: true,
        tokens: true,
        comment: true,
    });
    let className = null;

    ast = escodegen.attachComments(ast, ast.comments, ast.tokens);

    //console.log(JSON.stringify(ast)); return;
    ast.body.forEach((item, a) => {
        if (item.type === 'ExpressionStatement' && item.expression.type === 'AssignmentExpression'
            && item.expression.left.object.name === 'module'
            && item.expression.left.property.name === 'exports') {
            ast.body.splice(a, 1);
            return;
        }

        if (item.type === 'VariableDeclaration'
            && item.declarations[0].init.callee.property
            && item.declarations[0].init.callee.property.name === 'defineClass') {
            className = item.declarations[0].id.name;
            const properties = item.declarations[0].init.arguments[1].properties;

            ast.body[a] = classAst;
            classAst.body[0].expression.right.id.name = className;

            // Merge constructor
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === 'constructor') {
                    prop.value.body.body.forEach((expr, k) => {
                        if (expr.expression.type === 'CallExpression' && expr.expression.callee.type === 'MemberExpression' && expr.expression.callee.property.name === '__super') {
                            defaultConstructor.expression.arguments = expr.expression.arguments;
                            prop.value.body.body[k] = defaultConstructor;
                        }
                    });

                    classBodyAst[0] = prop;
                    properties[i] = null;
                }
            });

            // Find extends
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === '__extends') {
                    classAst.body[0].expression.right.superClass.name = prop.value.name;
                    properties[i] = null;
                }
            });

            // Each static
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === '__static') {
                    prop.value.properties.forEach(staticProp => {
                        // Static methods
                        if (staticProp.value.type === 'FunctionExpression') {
                            staticProp.static = true;
                            classBodyAst.push({
                                "type": "MethodDefinition",
                                "key": staticProp.key,
                                "computed": false,
                                "value": staticProp.value,
                                "kind": "method",
                                "static": true,
                                "range": staticProp.range,
                                "leadingComments": staticProp.leadingComments,
                            });
                        } else {
                            // Static props
                            classAst.body.push({
                                "type": "ExpressionStatement",
                                "expression": {
                                    "type": "AssignmentExpression",
                                    "operator": "=",
                                    "left": {
                                        "type": "MemberExpression",
                                        "computed": false,
                                        "object": {"type": "Identifier", "name": className},
                                        "property": {"type": "Identifier", "name": staticProp.key.name}
                                    },
                                    "right": staticProp.value
                                }
                            })
                        }
                    });
                    properties[i] = null;
                }
            });

            // Each prototype methods
            properties.forEach(prop => {
                if (prop && prop.value.type === 'FunctionExpression') {
                    classBodyAst.push(prop);
                }
            });

            // Each prototype properties
            let constructorBodyAst = classBodyAst[0].value.body.body;
            constructorBodyAst.unshift.apply(constructorBodyAst, properties.map(prop => {
                if (prop && prop.value.type !== 'FunctionExpression') {
                    // Check exists
                    const index = constructorBodyAst.findIndex(item => {
                        return item.type === 'ExpressionStatement' &&
                            item.expression.type === 'AssignmentExpression' &&
                            item.expression.left.type === 'MemberExpression' &&
                            item.expression.left.property.name === prop.key.name;
                    });

                    if (index === -1) {
                        return {
                            "type": "ExpressionStatement",
                            "expression": {
                                "type": "AssignmentExpression",
                                "operator": "=",
                                "left": {
                                    "type": "MemberExpression",
                                    "computed": false,
                                    "object": {"type": "ThisExpression"},
                                    "property": {"type": "Identifier", "name": prop.key.name}
                                },
                                "right": prop.value,
                                leadingComments: prop.leadingComments
                            }
                        };
                    } else {
                        constructorBodyAst[index].leadingComments = prop.leadingComments;
                    }
                }
            }).filter(v => v));
        }
    });

    // Remove empty constructor
    if (classBodyAst[0].value.body.body.length === 1) {
        classBodyAst.splice(0, 1);
    }

    if (className) {

        let resultCode = esformatter.format(
            escodegen.generate(ast, {
                comment: true,
            })
                // Format code
                .replace(/'use strict';/, '$&\n')
                .replace(/\nmodule\.exports = .*/, '\n$&\n')
                //.replace(/        \*/g, '    \*')
                //.replace(/\n    }/g, '\n    }\n')
                .replace(/\n};$/, '\n}')
                .replace(/    \/\*\*/g, '\n$&')
            ,
            {
                lineBreak: {
                    after: {
                        MethodDefinitionClosingBrace: 2,
                        ClassOpeningBrace: 2,
                    }
                }
            }
        );

        console.log(
            resultCode
        );
    }

};

if (process.argv[2]) {
    glob(process.argv[2], function(er, files) {
        if (er) {
            console.error(er);
        } else {
            files.forEach(file => {
                processFile(file);
            })
        }
    });
}