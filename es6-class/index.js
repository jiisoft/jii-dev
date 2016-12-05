const fs = require('fs');
const esprima = require('esprima');
const escodegen = require('escodegen');
const esformatter = require('esformatter');
const glob = require('glob');

const replaceSuperCalls = function(ast, funcName) {
    if (Array.isArray(ast.body)) {
        ast.body.forEach(item => {
            replaceSuperCalls(item, funcName);
        });
        return;
    }
    if (typeof ast.body === 'object') {
        replaceSuperCalls(ast.body, funcName);
        return;
    }

    if (ast.type === 'ExpressionStatement'
        && ast.expression.type === 'CallExpression'
        && ast.expression.callee.type === 'MemberExpression'
        && ast.expression.callee.property.name === '__super')
    {
        ast.expression.callee.object = {
            type: 'Super',
            range: ast.expression.callee.object.range,
        };
        ast.expression.callee.property.name = funcName;
    }
};

const processFile = function (path) {
    let content = fs.readFileSync(path).toString();

    // Skip without Jii class
    if (content.indexOf('Jii.defineClass') === -1) {
        return;
    }

    content = content.replace(/\r\n/g, '\n');
    content = content.replace(/\t/g, '    ');
    content = content.replace(/(\n *)(\n     +)/g, '$1        //__line-break-fix__$2');
    //console.log(content);return;

    if (content.indexOf('Jii.defineClass(') === -1) {
        return;
    }

    console.log(`Convert classes in file ${path}...`);

    let ast = esprima.parse(content, {
        range: true,
        tokens: true,
        comment: true,
    });
    let hasJiiClass = false;

    ast = escodegen.attachComments(ast, ast.comments, ast.tokens);

    //console.log(JSON.stringify(ast)); return;
    ast.body.forEach((item, a) => {
        let className = null;
        let properties = null;
        let classAst = null;

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

        if (item.type === 'ExpressionStatement'
            && item.expression
            && item.expression.type === 'AssignmentExpression'
            && item.expression.right.arguments) {
            className = item.expression.right.arguments[0].value.replace(/.*\.([^.]+)$/, '$1');
            properties = item.expression.right.arguments[1].properties;

            item.expression.right = classAst = {
                "type": "ClassExpression",
                "id": {"type": "Identifier", "name": className},
                "body": {
                    "type": "ClassBody",
                    "body": classBodyAst
                }
            }
        }

        if (item.type === 'VariableDeclaration'
            && item.declarations[0].init.callee.property
            && item.declarations[0].init.callee.property.name === 'defineClass') {
            className = item.declarations[0].id.name;
            properties = item.declarations[0].init.arguments[1].properties;

            ast.body[a] = classAst = {
                "type": "ClassExpression",
                "id": {"type": "Identifier", "name": className},
                "body": {
                    "type": "ClassBody",
                    "body": classBodyAst
                }
            };
        }

        if (className && properties) {
            hasJiiClass = true;

            // Merge constructor
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === 'constructor') {
                    prop.value.body.body.forEach((expr, k) => {
                        if (expr.type === 'ExpressionStatement'
                            && expr.expression.type === 'CallExpression'
                            && expr.expression.callee.type === 'MemberExpression')
                        {
                            if (expr.expression.callee.property.name === '__super') {
                                defaultConstructor.expression.arguments = expr.expression.arguments;
                                prop.value.body.body[k] = defaultConstructor;
                            }
                            if (expr.expression.callee.object.type === 'MemberExpression'
                                && expr.expression.callee.object.property.name === '__super'
                            ) {
                                prop.value.body.body[k] = defaultConstructor;
                            }
                        }
                    });

                    classBodyAst[0] = prop;
                    properties[i] = null;
                }
            });

            // Find extends
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === '__extends') {
                    classAst.superClass = {
                        type: "Identifier",
                        name: prop.value.name
                    };
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
                            ast.body.splice(a+1, 0, {
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
                                },
                                "leadingComments": staticProp.leadingComments,
                            });
                        }
                    });
                    properties[i] = null;
                }
            });

            // Each prototype methods
            properties.forEach(prop => {
                if (prop && prop.value.type === 'FunctionExpression') {

                    replaceSuperCalls(prop.value, prop.key.name);

                    classBodyAst.push({
                        "type": "MethodDefinition",
                        "key": prop.key,
                        "computed": false,
                        "value": prop.value,
                        "kind": "method",
                        "range": prop.value.range,
                        "leadingComments": prop.leadingComments,
                    });
                }
            });

            // Each prototype properties
            let constructorBodyAst = classBodyAst[0].value.body.body;
            let superCallIndex = 0;

            // Go super call to start constructor
            constructorBodyAst.forEach((cbaItem, cbaIndex) => {
                if (cbaItem.type === 'ExpressionStatement'
                    && cbaItem.expression.type === 'CallExpression'
                    && cbaItem.expression.callee.type === 'Super') {
                    constructorBodyAst.splice(cbaIndex, 1);
                    constructorBodyAst.unshift(cbaItem);
                    superCallIndex = 1;
                }
            });
            properties.forEach(prop => {
                if (prop && prop.value.type !== 'FunctionExpression') {
                    // Check exists
                    const index = constructorBodyAst.findIndex(bodyItem => {
                        return bodyItem.type === 'ExpressionStatement' &&
                            bodyItem.expression.type === 'AssignmentExpression' &&
                            bodyItem.expression.left.type === 'MemberExpression' &&
                            bodyItem.expression.left.property.name === prop.key.name;
                    });

                    if (index === -1) {
                        constructorBodyAst.splice(superCallIndex, 0, {
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
                        });
                    } else {
                        constructorBodyAst[index].leadingComments = prop.leadingComments;
                    }
                }
            });

            // Remove empty constructor
            if (classBodyAst[0].value.body.body.length === 1) {
                classBodyAst.splice(0, 1);
            }
        }
    });

    if (hasJiiClass) {

        let resultCode = esformatter.format(
            escodegen.generate(ast, {
                comment: true,
            })
                // Format code
                .replace(/'use strict';/, '$&\n')
                //.replace(/\nmodule\.exports = .*/, '\n$&\n')
                .replace(/\n};/, '\n}')

                // Line breaks fix
                .replace(/ *\/\/__line-break-fix__/g, '')

                // Super calls
                //.replace(/this\.__super\.apply\(this, arguments\);?/g, 'super(...arguments);')
                //.replace(/this\.__super\(/g, 'super(')
            ,
            {
                indent: {
                    value: "    ",
                },
                lineBreak: {
                    after: {
                        MethodDefinitionClosingBrace: 2,
                        ClassOpeningBrace: 2,
                    }
                }
            }
        );

        fs.writeFileSync(path, resultCode);
        //console.log(resultCode);
    }

};

process.argv.slice(2).forEach(item => {
    glob(item, function (er, files) {
        if (er) {
            console.error(er);
        } else {
            files.forEach(file => {
                // Skip node_modules
                if (/node_modules/.test(file)) {
                    return;
                }

                processFile(file);
            })
        }
    });
});
