"""navkit — turns a reconstruction (Gaussian splat or point cloud) into a navigable scene.

Pipeline stages (each is a small, independently testable module):

    io_ply     read point clouds / 3DGS .ply files, write web-ready .splat files
    align      gravity alignment (RANSAC floor plane), Manhattan yaw, metric scale
    grid       rasterise floor / obstacle evidence and extract the walkable mask
    suggest    propose POIs (furniture-sized obstacle blobs) and zones (open areas)
    build      orchestrates the stages and writes the scene bundle used by the web app
"""

__version__ = "2.0.0"
