import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { RoutingPresetConfig } from 'manifest-shared';
import { timestampDefault, timestampType } from '../common/utils/postgres-sql';

@Entity('routing_presets')
@Index(['tenant_id', 'name'], { unique: true })
export class RoutingPresetEntity {
  @PrimaryColumn('varchar') id!: string;
  @Column('varchar') tenant_id!: string;
  @Column('varchar', { length: 80 }) name!: string;
  @Column('jsonb') config!: RoutingPresetConfig;
  @Column(timestampType(), { default: timestampDefault() }) created_at!: string;
  @Column(timestampType(), { default: timestampDefault() }) updated_at!: string;
}
