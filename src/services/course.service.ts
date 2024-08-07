import { findAllCourseChapter } from '../database/cache/course.chache';
import { getAllHashCache, getHashCache, insertHashCache, insertHashListCache, removeFromHashListCache } from '../database/cache/index.cache';
import { findCourseWithRelations, findSimilarTags, insertChapterAndVideos, insertCourse, insertCourseBenefit, insertNewTags, patchCourseChapter, removeTags, updateChapterVideos, updateCourse, updateTags
} from '../database/queries/course.query';
import { ResourceNotFoundError } from '../libs/utils';
import ErrorHandler from '../libs/utils/errorHandler';
import type { ChapterAndVideoDetails, courseBenefitAndDetails, CourseGeneric, CourseRelations, FilteredChapters, InsectCourseDetailsBody, ModifiedChapterDetail, Entries, TErrorHandler, TSelectCourse, TSelectCourseBenefit, TSelectTags, TSelectVideoDetails, 
    uploadVideoDetailResponse, TSelectChapter, InsertVideoDetails, 
} from '../types/index.type';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import pLimit from 'p-limit';
import crypto from 'crypto';

export const createCourseService = async <T extends CourseGeneric<'insert'>>(courseDetail : InsectCourseDetailsBody<T>) : Promise<TSelectCourse> => {
    try {
        const courseDetails : TSelectCourse = await insertCourse(courseDetail);
        await insertHashCache(`course:${courseDetails.id}`, courseDetails);
        return courseDetails;
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
};

export const editCourseDetailsService = async <B extends CourseGeneric<'update'>>(courseDetail : Partial<InsectCourseDetailsBody<B>>, 
    courseId : string, currentStudentId : string, tags : string[], courseCache : TSelectCourse) : Promise<TSelectCourse> => {
    try {
        let currentTags : TSelectTags[];
        const currentTagsData : Record<string, string> = await getAllHashCache<Record<string, string>>(`course_tags:${courseId}`);
        const newTagsSet : Set<string> = new Set(tags);

        const entries : Entries[] = Object.entries(currentTagsData).map(([key, value]) => ({key, value}));
        currentTags = entries.map(entry => JSON.parse(entry.value)) as TSelectTags[];
        if(Object.keys(currentTagsData).length === 0) currentTags = await findSimilarTags(courseId) as TSelectTags[];

        const existingTagsSet : Set<string | never[]> = new Set(currentTags.map(tag => tag.tags));
        const tagsToAdd : string[] = tags.filter(tag => !existingTagsSet.has(tag));
        const removedTags : TSelectTags[] = currentTags.filter(tagObj => !newTagsSet.has(tagObj.tags))
        const updatedTags : TSelectTags[] = currentTags.filter(tagObj => newTagsSet.has(tagObj.tags) && !tags.includes(tagObj.tags));

        await handleTags(tagsToAdd, removedTags, updatedTags, courseId);
        const uploadedImageUrl : string | undefined = await handleImageUpload(courseDetail.image ?? undefined, courseCache.image ?? null);

        const updatedDetails : TSelectCourse = await updateCourse({
            ...courseDetail, image : uploadedImageUrl, prerequisite : courseDetail.prerequisite?.join(' ')
        }, courseId);
        await insertHashCache(`course:${courseId}`, updatedDetails);
        return updatedDetails;

    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const combineTagAndCourseId = (tags : string[], courseId : string) : Omit<TSelectTags, 'id'>[] => {
    return tags.map(tag => ({tags : tag, courseId}));
}

export const handleTags = async (tagsToAdd : string[], removedTags : TSelectTags[], updatedTags : TSelectTags[], courseId : string) : 
Promise<void> => {
    const operations = [
        () => insertNewTagsIfNeeded(tagsToAdd, courseId),
        () => removeTagsIfNeeded(removedTags, courseId),
        ...updatedTags.map(tag => () => updateTags(tag.id, tag.tags))
    ];
    await Promise.all(operations.map(operation  => operation()));
}

export const insertNewTagsIfNeeded = async (tagsToAdd : string[], courseId : string) : Promise<void> => {
    if(tagsToAdd && tagsToAdd.length > 0) {
        const newTags : TSelectTags[] = await insertNewTags(combineTagAndCourseId(tagsToAdd, courseId));
        newTags.map(async tag => await insertHashListCache(`course_tags:${courseId}`, tag.id, tag));
    }
}

const removeTagsIfNeeded = async (removedTags : TSelectTags[], courseId : string) : Promise<void> => {
    if (removedTags.length > 0) {
        await removeTags(removedTags.map(tag => tag.id));
        removedTags.map(async tag => await removeFromHashListCache(`course_tags:${courseId}`, tag.id));
    }
}
const handleImageUpload = async (newImage : string | undefined, currentImage : string | null) : Promise<string | undefined> => {
    if(currentImage?.length && newImage?.length) {
        await cloudinary.uploader.destroy(currentImage.split('/').pop()!.split('.')[0]);
        const uploadResponse : UploadApiResponse | undefined = newImage ? await cloudinary.uploader.upload(newImage) : undefined
        return uploadResponse?.secure_url || undefined;
    }
    const uploadedResponse : UploadApiResponse | undefined = newImage ? await cloudinary.uploader.upload(newImage) : undefined
    return uploadedResponse?.secure_url || undefined;
}

export const courseBenefitService = async (benefits : Omit<TSelectCourseBenefit, 'id'>[], courseId : string, currentStudentId : string, 
    course : TSelectCourse) : Promise<courseBenefitAndDetails> => {
    try {
        const benefitResult : TSelectCourseBenefit[] = await insertCourseBenefit(benefits);
        await Promise.all(benefitResult.map<void>(async benefit => {
            insertHashCache(`course_benefits:${benefit.id}`, benefit)
        }));

        return {course, benefits : benefitResult};
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const createCourseChapterService = async (videoDetails : Omit<TSelectVideoDetails, 'id'>[], chapterDetail : ModifiedChapterDetail, 
    courseId : string) : Promise<ChapterAndVideoDetails> => {
    try {
        const uploadedResponse : uploadVideoDetailResponse[] = await uploadVideoDetails(videoDetails);
        const responseMap : Map<string, uploadVideoDetailResponse> = new Map(uploadedResponse.map(upload => [upload.videoTitle, upload]));

        videoDetails.forEach(video => {
            const upload : uploadVideoDetailResponse | undefined = responseMap.get(video.videoTitle);
            if(upload) video.videoUrl = upload.videoUploadResponse.secure_url;
        });
        
        const { chapterDetails, videoDetail } = await insertChapterAndVideos({...chapterDetail, courseId : courseId}, videoDetails);
        
        await insertHashCache(`course:${courseId}:chapters:${chapterDetails.id}`, chapterDetails),
        await Promise.all(videoDetail.map(async video => {
            insertHashListCache(`course_videos:${video.chapterId}`, video.id, video);
        }));

        return { chapterDetails : chapterDetails, videoDetail } as ChapterAndVideoDetails;
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

const generateHash = (input : string) : string => {
    return crypto.createHash('sha256').update(input).digest('hex');
}
// 1. Check whay we need to search like `course:${courseId}:chapter:*` and now `course:${courseId}:chapter:${chapterId}`
export const updateCourseChapterService = async (chapterId : string, courseId : string, currentTeacherId : string, 
chapterDetails : Partial<ModifiedChapterDetail>) : Promise<TSelectChapter> => {
    try {
        const existingChapterDetail : TSelectChapter | null = await findAllCourseChapter(`course:${courseId}:chapters:*`, chapterId);  
        const changedValue = new Map<keyof Partial<ModifiedChapterDetail>, string | null>();

        Object.keys(chapterDetails).forEach(key => {
            const detailKey = key as keyof Partial<ModifiedChapterDetail>;
            if(chapterDetails[detailKey] !== undefined) {
                const newValue : string | null = chapterDetails[detailKey] ?? null;
                const oldValue : string | null = existingChapterDetail ? existingChapterDetail[detailKey] : null;

                const newHash : string | null = newValue ? generateHash(newValue) : null;
                const oldHash : string | null = oldValue ? generateHash(oldValue) : null;

                if(newHash !== oldHash) changedValue.set(detailKey, newValue);
            }
        });
        const valuesToAdd : Partial<ModifiedChapterDetail> = Object.fromEntries(changedValue);

        if(Object.keys(valuesToAdd).length) {
            const updatedChapterDetail : TSelectChapter = await patchCourseChapter(chapterId, valuesToAdd);
            await insertHashCache(`course:${courseId}:chapters:${chapterId}`, updatedChapterDetail);
            return updatedChapterDetail;
        }

        return existingChapterDetail!;
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const updateChapterVideoDetailService = async (chapterId : string, videoId : string, currentTeacherId : string, 
videoDetail : InsertVideoDetails) : Promise<TSelectVideoDetails> => {
    try {
        const videoCache : TSelectVideoDetails = JSON.parse(await getHashCache(`course_videos:${chapterId}`, videoId));
        if(!videoCache || Object.keys(videoCache).length === 0) throw new ResourceNotFoundError();
        await handleOldVideo(videoCache.videoUrl);

        const videoUploadResponse : uploadVideoDetailResponse[] = await uploadVideoDetails([videoDetail]);
        const updatedVideoDetail : TSelectVideoDetails = await updateChapterVideos({
            ...videoDetail, videoUrl : videoUploadResponse[0].videoUploadResponse.secure_url
        }, videoId);
        await insertHashListCache(`course_videos:${chapterId}`, videoId, updatedVideoDetail);

        return updatedVideoDetail;
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}

export const handleOldVideo = async (videoUrl : string) : Promise<void> => {
    await cloudinary.uploader.destroy(videoUrl.split('/').pop()!.split('.')[0], {resource_type : 'video'});
}

const uploadVideoDetails = async <T extends InsertVideoDetails>(videoDetails : T[]) : Promise<uploadVideoDetailResponse[]> => {
    const limit = pLimit(10);
    const uploadResponse : Promise<uploadVideoDetailResponse>[] = videoDetails.map(video => {
        return limit(async () => {
            const videoUploadResponse : UploadApiResponse = await cloudinary.uploader.upload_large(video.videoUrl, {
                resource_type : 'video'
            });
            return {videoTitle : video.videoTitle, videoUploadResponse};
        });
    });
    const uploadedResponse : uploadVideoDetailResponse[] = await Promise.all(uploadResponse);
    return uploadedResponse;
}
// 1. Add the teacher and admin have the course for free
// 2. Make sure to add visibility options to joi validation
// 3 remove the purchase onj in courseService
export const courseService = async (currentStudentId : string, courseId : string) : Promise<CourseRelations> => {
    try {
        const courseDetail : CourseRelations = await findCourseWithRelations(courseId);
        if(courseDetail?.visibility !== 'publish') throw new ResourceNotFoundError();
        const studentHasPurchased : boolean | undefined = courseDetail?.purchases?.some(student => student.studentId === currentStudentId);

        const filteredChapters : FilteredChapters = courseDetail?.chapters?.filter(chapter => chapter.visibility !== 'draft')
        .map(chapter => ({...chapter, videos : chapter.videos.filter(video => studentHasPurchased || video.state === 'free')}));

        const { purchases, ...courseDetails } = courseDetail;
        const modifiedCourse : CourseRelations = {...courseDetails, chapters : filteredChapters} as CourseRelations;
        return modifiedCourse;
        
    } catch (err : unknown) {
        const error = err as TErrorHandler;
        throw new ErrorHandler(`An error occurred : ${error.message}`, error.statusCode);
    }
}