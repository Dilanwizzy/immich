import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AssetEntity, AssetType, ExifEntity, UserEntity } from '@app/infra';
import { ConfigService } from '@nestjs/config';
import { userUtils } from '@app/common';
import { IJobRepository, JobName } from '@app/domain';
import { isNull } from 'lodash';

@Injectable()
export class ScheduleTasksService {
  constructor(
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    @InjectRepository(AssetEntity)
    private assetRepository: Repository<AssetEntity>,

    @InjectRepository(ExifEntity)
    private exifRepository: Repository<ExifEntity>,

    @Inject(IJobRepository) private jobRepository: IJobRepository,

    private configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async webpConversion() {
    const assets = await this.assetRepository.find({
      where: {
        webpPath: '',
      },
    });

    if (assets.length == 0) {
      Logger.log('All assets has webp file - aborting task', 'CronjobWebpGenerator');
      return;
    }

    for (const asset of assets) {
      await this.jobRepository.add({ name: JobName.GENERATE_WEBP_THUMBNAIL, data: { asset } });
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async videoConversion() {
    const assets = await this.assetRepository.find({
      where: {
        type: AssetType.VIDEO,
        mimeType: 'video/quicktime',
        encodedVideoPath: '',
      },
      order: {
        createdAt: 'DESC',
      },
    });

    for (const asset of assets) {
      await this.jobRepository.add({ name: JobName.VIDEO_CONVERSION, data: { asset } });
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async reverseGeocoding() {
    const isGeocodingEnabled = this.configService.get('DISABLE_REVERSE_GEOCODING') !== 'true';

    if (isGeocodingEnabled) {
      const exifInfo = await this.exifRepository.find({
        where: {
          city: IsNull(),
          longitude: Not(IsNull()),
          latitude: Not(IsNull()),
        },
      });

      for (const exif of exifInfo) {
        await this.jobRepository.add({
          name: JobName.REVERSE_GEOCODING,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          data: { exifId: exif.id, latitude: exif.latitude!, longitude: exif.longitude! },
        });
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async extractExif() {
    const exifAssets = await this.assetRepository
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.exifInfo', 'ei')
      .where('ei."assetId" IS NULL')
      .getMany();

    for (const asset of exifAssets) {
      if (asset.type === AssetType.VIDEO) {
        await this.jobRepository.add({ name: JobName.EXTRACT_VIDEO_METADATA, data: { asset, fileName: asset.id } });
      } else {
        await this.jobRepository.add({ name: JobName.EXIF_EXTRACTION, data: { asset, fileName: asset.id } });
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_11PM)
  async deleteUserAndRelatedAssets() {
    const usersToDelete = await this.userRepository.find({ withDeleted: true, where: { deletedAt: Not(IsNull()) } });
    for (const user of usersToDelete) {
      if (userUtils.isReadyForDeletion(user)) {
        await this.jobRepository.add({ name: JobName.USER_DELETION, data: { user } });
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async deleteAssetsInRecycleBin() {
    const assetsToDelete = await this.assetRepository.find({ where: { deletedAt: Not(IsNull()), isVisible: false } });
    for (const asset of assetsToDelete) {
      await this.jobRepository.add({ name: JobName.RECYCLE_BIN_CLEANUP, data: { asset } });
    }
  }
}
