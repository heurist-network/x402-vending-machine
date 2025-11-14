
export enum LaunchStatus {
    open = 'open',
    graduated = 'graduated',
    refundable = 'refundable',
}

export interface SaleInfo {
    currentUSDC: number;
    targetUSDC: number;
    totalPurchases: number;
    queuedPurchases: number;
}

// /launches endpoint response
export interface TokenResponse {
    name: string;
    symbol: string;
    tokenAddress: string;
    creatorAddress: string;
    createdAtTimestamp: number; // use unix timestamp in seconds
    status: LaunchStatus;
    saleInfo: SaleInfo;
    marketCap: number; // use number in USD 
    links: Record<string, string>;
    image: string | null;
    description: string | null;
}

// /tokens/:tokenAddress endpoint response
export type LaunchResponse = TokenResponse;
export type TokenDetailResponse = TokenResponse;

export interface PaginationInfo {
    currentPage: number;
    totalItems: number;
    totalPages: number;
}

export interface LaunchesResponse {
    data: TokenResponse[];
    pagination: PaginationInfo;
}

export interface PlatformStatsResponse {
    totalRaisedUSDC: string;
    totalLaunches: number;
    graduatedLaunches: number;
    openLaunches: number;
}

export interface X402Kind {
    extra: Record<string, any>;
    network: string;
    scheme: string;
    x402Version: number;
}

export interface FacilitatorHealthResponse {
    kinds: X402Kind[];
}

export interface ErrorResponse {
    error: string;
    message?: string;
    details?: any;
}
