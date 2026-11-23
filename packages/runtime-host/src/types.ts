export interface PlacedEntity {
  type: string;
  dimension: string;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number };
  uuid?: string;
  name?: string;
  tags: string[];
  persistent: boolean;
  invisible?: boolean;
  professionEvent?: string;
  equipment: { slot: string; type: string; count: number; damage?: number }[];
  scores: [string, number][];
}
export type ObjectiveData = [string, [string, number][]][];
