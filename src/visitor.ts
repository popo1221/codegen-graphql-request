import {
  ClientSideBasePluginConfig,
  ClientSideBaseVisitor,
  DocumentMode,
  getConfigValue,
  indentMultiline,
  LoadedFragment,
} from '@graphql-codegen/visitor-plugin-common';
import autoBind from 'auto-bind';
import { GraphQLSchema, Kind, OperationDefinitionNode, print } from 'graphql';
import { RawGraphQLRequestPluginConfig } from './config';

export interface GraphQLRequestPluginConfig extends ClientSideBasePluginConfig {
  rawRequest: boolean;
}

const additionalExportedTypes = `
export type Variables = { [key: string]: any }
export type SdkFunctionWrapper<RequestOptions extends any> = <T>(
  action: (requestOpts?: RequestOptions) => Promise<T>,
  operationName: string
) => Promise<T>
export type RequestDocument = string | DocumentNode
export type RequestFunction<RequestOptions = any> = <T = any, V = Variables>(
  document: RequestDocument,
  variables?: V,
  requestOpts?: RequestOptions
) => Promise<T>
`;

export class GraphQLRequestVisitor extends ClientSideBaseVisitor<
  RawGraphQLRequestPluginConfig,
  GraphQLRequestPluginConfig
> {
  private _operationsToInclude: {
    node: OperationDefinitionNode;
    documentVariableName: string;
    operationType: string;
    operationResultType: string;
    operationVariablesTypes: string;
  }[] = [];

  constructor(schema: GraphQLSchema, fragments: LoadedFragment[], rawConfig: RawGraphQLRequestPluginConfig) {
    super(schema, fragments, rawConfig, {
      rawRequest: getConfigValue(rawConfig.rawRequest, false),
    });

    autoBind(this);

    const typeImport = this.config.useTypeImports ? 'import type' : 'import';

    this._additionalImports.push(`${typeImport} { DocumentNode } from 'graphql';`);
  }

  // @ts-ignore
  public OperationDefinition(node: OperationDefinitionNode) {
    const operationName = node.name?.value;

    if (!operationName) {
      // eslint-disable-next-line no-console
      console.warn(
        `Anonymous GraphQL operation was ignored in "typescript-graphql-request", please make sure to name your operation: `,
        print(node)
      );

      return null;
    }

    return super.OperationDefinition(node);
  }

  protected buildOperation(
    node: OperationDefinitionNode,
    documentVariableName: string,
    operationType: string,
    operationResultType: string,
    operationVariablesTypes: string
  ): string {
    this._operationsToInclude.push({
      node,
      documentVariableName,
      operationType,
      operationResultType,
      operationVariablesTypes,
    });

    return '';
  }

  private getDocumentNodeVariable(documentVariableName: string): string {
    return this.config.documentMode === DocumentMode.external
      ? `Operations.${documentVariableName}`
      : documentVariableName;
  }

  public get sdkContent(): string {
    const extraVariables: string[] = [];
    const allPossibleActions = this._operationsToInclude
      .map(o => {
        // @ts-ignore
        const operationName = o.node.name.value;
        const optionalVariables =
          !o.node.variableDefinitions ||
          o.node.variableDefinitions.length === 0 ||
          o.node.variableDefinitions.every(v => v.type.kind !== Kind.NON_NULL_TYPE || v.defaultValue);
        const docVarName = this.getDocumentNodeVariable(o.documentVariableName);

        return `${operationName}(variables${optionalVariables ? '?' : ''}: ${
          o.operationVariablesTypes
        }, requestOpts?: RequestOptions): Promise<${o.operationResultType}> {
return withWrapper((wrappedRequestOpts?: RequestOptions) => request<${
  o.operationResultType
}>(${docVarName}, variables, {...requestOpts, ...wrappedRequestOpts} as RequestOptions), '${operationName}');
}`;
      })
      .filter(Boolean)
      .map(s => indentMultiline(s, 2));

    return `${additionalExportedTypes}


const defaultWrapper: SdkFunctionWrapper<any> = (action, _operationName) => action()
${extraVariables.join('\n')}
export function getSdk<RequestOptions extends Record<string, any>>(
  request: RequestFunction<RequestOptions>,
  withWrapper: SdkFunctionWrapper<RequestOptions> = defaultWrapper
) {
  return {
${allPossibleActions.join(',\n')}
  };
}
export type Sdk = ReturnType<typeof getSdk>;`;
  }
}
