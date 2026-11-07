export interface ModuleContract<TApi = any> {
  readonly id: string
  readonly name?: string
  readonly version?: string
  readonly api?: number
  readonly provides?: ReadonlyArray<string>
  readonly requires?: ReadonlyArray<string>
  readonly conflicts?: ReadonlyArray<string>
  readonly defaultEnabled?: boolean
  readonly requiresGUI?: boolean
  readonly configVersion?: number
  readonly storageVersion?: number
  readonly setup: (api: TApi) => unknown
  readonly [key: string]: unknown
}

export interface NormalizedModuleContract<TApi = any> extends ModuleContract<TApi> {
  readonly api: number
  readonly configVersion: number
  readonly storageVersion: number
  readonly provides: string[]
  readonly requires: string[]
  readonly conflicts: string[]
}

export declare function validateModuleContract<TApi = any>(definition: ModuleContract<TApi>): NormalizedModuleContract<TApi>
