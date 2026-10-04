export interface ActiveEndpoint {
  readonly id: string;
}

export interface EndpointRepository {
  findActive(): Promise<readonly ActiveEndpoint[]>;
}
