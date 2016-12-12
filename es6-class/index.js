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

    let expression = null;

    // Search for '__super' calls in regular expressions and in return statements
    if (ast.type === 'ExpressionStatement') {
        expression = ast.expression;
    } else if (ast.type === 'ReturnStatement') {
        expression = ast.argument;
    }

    if (expression
        && expression.type === 'CallExpression'
        && expression.callee.type === 'MemberExpression'
        && expression.callee.property.name === '__super')
    {
        expression.callee.object = {
            type: 'Super',
            range: expression.callee.object.range,
        };
        expression.callee.property.name = funcName;
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

    // Existing code tree
    let ast = esprima.parse(content, {
        range: true,
        tokens: true,
        comment: true,
    });
    let hasJiiClass = false;
    let isChild = false;

    ast = escodegen.attachComments(ast, ast.comments, ast.tokens);

    //console.log(JSON.stringify(ast)); return;
    ast.body.forEach((item, a) => {
        let className = null;
        let properties = null;
        let classAst = null;

        // Result: super(...arguments);
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

        // Result: super.preInit(...arguments);
        const parentPreInitCall = {
            "type": "ExpressionStatement",
            "expression": {
                "type": "CallExpression",
                "callee": {
                    "type": "MemberExpression",
                    "computed": false,
                    "object": {"type": "Super"},
                    "property": {
                        "type": "Identifier",
                        "name": "preInit"
                    }
                },
                "arguments": [{
                    "type": "SpreadElement",
                    "argument": {"type": "Identifier", "name": "arguments"}
                }]
            }
        };

        // Result: constructor() { super(); }
        let classBodyAst = [
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

        // Result: constructor() { this.preInit(...arguments); }
        const emptyConstructorBodyAst = [
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
                        "body": [{
                            "type": "ExpressionStatement",
                            "expression": {
                                "type": "CallExpression",
                                "callee": {
                                    "type": "MemberExpression",
                                    "computed": false,
                                    "object": {"type": "ThisExpression"},
                                    "property": {"type": "Identifier", "name": "preInit"}
                                },
                                "arguments": [{
                                    "type": "SpreadElement",
                                    "argument": {"type": "Identifier", "name": "arguments"}
                                }]
                            }
                        }]
                    },
                    "generator": false,
                    "expression": false
                },
                "kind": "constructor",
                "static": false
            }
        ];

        const preInitFn = {
            "type": "MethodDefinition",
            "key": {"type": "Identifier", "name": "preInit"},
            "computed": false,
            "value": {
                "type": "FunctionExpression",
                "id": null,
                "params": [],
                "body": {
                    "type": "BlockStatement",
                    "body": []
                },
                "generator": false,
                "expression": false
            },
            "kind": "init",
            "static": false
        };

        // Looking for 'module.exports = Jii.defineClass' type of class definition
        // and move class content to the new 'class' block
        if (item.type === 'ExpressionStatement'
            && item.expression
            && item.expression.type === 'AssignmentExpression'
            && item.expression.right.arguments
            && item.expression.right.callee
            && item.expression.right.callee.property.name == 'defineClass'
        ) {
            // E.g. extract 'ActiveRecordTest' from 'tests.unit.ActiveRecordTest'
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

        // Looking for 'var <className> = Jii.defineClass' type of class definition
        // and move class content to the new 'class' block
        if (item.type === 'VariableDeclaration'
            && item.declarations[0].init.callee
            && item.declarations[0].init.callee.property
            && item.declarations[0].init.callee.property.name === 'defineClass'
        ) {
            className = item.declarations[0].id.name;
            properties = item.declarations[0].init.arguments[1].properties;

            // Overwrite current item with the class declaration
            ast.body[a] = classAst = {
                "type": "ClassExpression",
                "id": {"type": "Identifier", "name": className},
                "body": {
                    "type": "ClassBody",
                    "body": classBodyAst
                }
            };
        }

        // If 'Jii.defineClass' declaration is found
        if (className && properties) {
            hasJiiClass = true;

            // Find extends and replace it with the ES6 class extend syntax
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === '__extends') {
                    let superClassName = "";

                    // Superclass could be either single class ('React') or a subclass ('React.Component')
                    if (prop.value.type = 'MemberExpression'
                            && prop.value.object
                            && prop.value.property
                    ) {
                        superClassName = prop.value.object.name + "." + prop.value.property.name;
                    } else {
                        superClassName = prop.value.name;
                    }

                    classAst.superClass = {
                        type: "Identifier",
                        name: superClassName
                    };

                    // Delete old '__extends' from the AST
                    properties[i] = null;

                    isChild = true;
                }
            });

            let constructorExists = false;

            // Process the existing constructor to create a new one
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === 'constructor') {

                    constructorExists = true;

                    prop.value.body.body.forEach((expr, k) => {

                        let isSuperCall = false;

                        // If it's a call of this.<method>
                        if (expr.type === 'ExpressionStatement'
                            && expr.expression.type === 'CallExpression'
                            && expr.expression.callee.type === 'MemberExpression')
                        {

                            // Replace 'this.__super(args)' with 'super(args)'
                            if (expr.expression.callee.property.name === '__super') {
                                isSuperCall = true;
                                defaultConstructor.expression.arguments = expr.expression.arguments;
                                parentPreInitCall.expression.arguments = expr.expression.arguments;
                                prop.value.body.body[k] = defaultConstructor;
                            }

                            if (expr.expression.callee.object.type === 'MemberExpression'
                                && expr.expression.callee.object.property.name === '__super'
                            ) {
                                isSuperCall = true;
                                prop.value.body.body[k] = defaultConstructor;
                            }
                        }

                        // Add all expression to the preInitFn except __super calls
                        if (!isSuperCall) {
                            preInitFn.value.body.body.push(expr);
                        } else {

                            // If there is no __super call and the class is a child of other class
                            // then add super.preInit(...arguments) to the preInitFn
                            if (isChild) {
                                preInitFn.value.body.body.push(parentPreInitCall);
                            }
                        }
                    });

                    // Replace default constructor with the newly created
                    classBodyAst[0] = prop;

                    // Pass constructor params to the 'preInit' method
                    preInitFn.value.params = classBodyAst[0].value.params;

                    // Delete old constructor from the AST
                    properties[i] = null;
                }
            });

            // Move properties and methods definitions out of '__static' object
            properties.forEach((prop, i) => {
                if (prop && prop.key.name === '__static') {
                    prop.value.properties.forEach(staticProp => {

                        // Move static functions definition to the new constructor
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
                        }

                        // Move static property definition to a single expression after the class block
                        // E.g.: <ClassName>.EVENT_ADD = 'add''
                        else {
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

                    // Remove old '__static' object from the class
                    properties[i] = null;
                }
            });

            // Replace 'super' calls in the class' methods
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

            // Move 'super' calls to the beginning of the constructor
            constructorBodyAst.forEach((cbaItem, cbaIndex) => {
                if (cbaItem.type === 'ExpressionStatement'
                    && cbaItem.expression.type === 'CallExpression'
                    && cbaItem.expression.callee.type === 'Super'
                ) {
                    constructorBodyAst.splice(cbaIndex, 1);
                    constructorBodyAst.unshift(cbaItem);
                    superCallIndex = 1;
                }
            });

            properties.forEach(prop => {

                // Search for the properties declarations/initializations in the class (e.g.: "id: null")
                if (prop && prop.value.type !== 'FunctionExpression') {

                    // Check if this property value is replaced by some value in the constructor
                    const index = constructorBodyAst.findIndex(bodyItem => {
                        return bodyItem.type === 'ExpressionStatement' &&
                            bodyItem.expression.type === 'AssignmentExpression' &&
                            bodyItem.expression.left.type === 'MemberExpression' &&
                            bodyItem.expression.left.property.name === prop.key.name;
                    });

                    // If the property is not replaced, then add it's initial declaration
                    // to the constructor right after 'super' call
                    if (index === -1) {
                        const propertyDeclaration = {
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

                        // Add property to the constructor after super call
                        constructorBodyAst.splice(superCallIndex, 0, propertyDeclaration);

                        // Add property to the beginning of preInitFn
                        preInitFn.value.body.body.unshift(propertyDeclaration);
                    } else {
                        constructorBodyAst[index].leadingComments = prop.leadingComments;
                    }
                }
            });

            // Remove empty constructor
            if (classBodyAst[0].value.body.body.length === 1) {
                classBodyAst.splice(0, 1);
            }

            if (constructorExists) {
                // If there is a constructor in class and the class isn't a child
                // then replace existing constructor with the new one and add preInitFn after it
                if (!isChild) {
                    classBodyAst[0] = emptyConstructorBodyAst[0];
                    classBodyAst.splice(1, 0, preInitFn);
                }

                // If the class is a child, then replace default constructor with preInitFn
                else {
                    classBodyAst[0] = preInitFn;
                }
            } else if (preInitFn.value.body.body.length) {
                if (isChild) {
                    preInitFn.value.body.body.push(parentPreInitCall);
                }

                classBodyAst[0] = preInitFn;
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
        // console.log(resultCode);
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
            });
        }
    });
});
