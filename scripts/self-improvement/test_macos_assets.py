import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
import macos_assets as A
from macos_manifest import NativeRefused,canonical,digest,tree_manifest
from macos_build import fixed_commands

class NativeAssetCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name).resolve();self.root=self.base/'source with spaces';self.home=self.base/'home';self.directory=self.root/'.asael-native-tools';self.directory.mkdir(parents=True);self.home.mkdir()
        catalog=self.root/A.CATALOG;catalog.mkdir(parents=True);(catalog/'Contents.json').write_text('{"info":{"version":1}}')
        self.cache=self.base/'cache';self.cache.mkdir();compiler=self.base/'actool';compiler.write_bytes(b'fixed compiler')
        self.old={'compiler':str(compiler),'catalog':'/original/catalog','output':'/original/output','dependencies':'/original/dependencies','partial':'/original/partial','options':A.OPTIONS}
        blobs={'AppIcon.icns':b'icon','Assets.car':b'catalog','partial.plist':plistlib.dumps({'CFBundleIconFile':'AppIcon','CFBundleIconName':'AppIcon'}),'dependencies':A.dependency_bytes(b'actool-25098',self.old['catalog'],self.old['partial'],self.old['output'])}
        for name,raw in blobs.items():(self.cache/name).write_bytes(raw)
        self.record={'version':1,'generatorSha256':digest(Path(A.__file__).read_bytes()),'catalog':A.CATALOG,'catalogManifest':tree_manifest(catalog,'bundle'),'compiler':str(compiler),'compilerSha256':digest(compiler.read_bytes()),'dependencyVersion':'actool-25098','options':A.OPTIONS,'originalRecipe':self.old,'outputs':{k:digest(v) for k,v in blobs.items()}}
        self.ref=self.seal()
    def seal(self):
        body={k:v for k,v in self.record.items() if k!='cacheSha256'};self.record={**body,'cacheSha256':digest(body)};raw=canonical(self.record)+b'\n';(self.cache/'asset-cache.json').write_bytes(raw);return {'path':str(self.cache),'recordSha256':digest(raw),'cacheSha256':self.record['cacheSha256']}
    def argv(self,variant='thinned'):
        base=self.home/'DerivedData/Build/Intermediates.noindex/Runner.build/Release/Runner.build'
        return [str(self.root/A.CATALOG),'--compile',str(base/'assetcatalog_output'/variant),*A.OPTIONS[:4],'--export-dependency-info',str(base/('assetcatalog_dependencies_'+variant)),'--output-partial-info-plist',str(base/('assetcatalog_generated_info.plist_'+variant)),*A.OPTIONS[4:]]
    def test_copy_is_exact_and_unknown_options_or_destination_refuse(self):
        wrapper=A.prepare_asset_cache(self.root,self.home,self.directory,self.ref);self.directory.chmod(0o500)
        for variant in ('thinned','unthinned','thinned'):
            args=self.argv(variant);run=subprocess.run([str(wrapper),*args],env={'PATH':'/usr/bin:/bin'},capture_output=True);self.assertEqual(run.returncode,0)
            self.assertEqual((Path(args[2])/'Assets.car').read_bytes(),b'catalog');self.assertEqual(Path(args[10]).read_bytes(),(self.cache/'partial.plist').read_bytes());self.assertNotIn(b'/original/',Path(args[8]).read_bytes())
        for args in ([*self.argv(),'--unexpected'],[str(self.base/'foreign'),*self.argv()[1:]],self.argv()[:2]+[str(self.base/'escape')]+self.argv()[3:]):
            self.assertEqual(subprocess.run([str(wrapper),*args],env={},capture_output=True).returncode,64)
        self.assertFalse((self.base/'escape').exists())
    def test_catalog_drift_refuses_before_staging(self):
        (self.root/A.CATALOG/'Contents.json').write_text('changed')
        with self.assertRaisesRegex(NativeRefused,'native_tree_changed'):A.prepare_asset_cache(self.root,self.home,self.directory,self.ref)
        self.assertFalse((self.directory/'assets').exists())
    def test_artifact_and_generator_drift_refuse(self):
        (self.cache/'Assets.car').write_bytes(b'changed')
        with self.assertRaisesRegex(NativeRefused,'native_asset_output_changed'):A.read_asset_cache(self.ref)
        (self.cache/'Assets.car').write_bytes(b'catalog');self.record['generatorSha256']='0'*64;self.ref=self.seal()
        with self.assertRaisesRegex(NativeRefused,'native_asset_cache_changed'):A.read_asset_cache(self.ref)
    def test_partial_plist_cannot_inject_version_source_or_other_metadata(self):
        for addition in ({'CFBundleVersion':'999'},{'sourcePath':'/private/source'},{'CFBundleExecutable':'other'}):
            with self.subTest(addition=addition),self.assertRaisesRegex(NativeRefused,'native_asset_partial_changed'):A.validate_partial(plistlib.dumps({'CFBundleIconFile':'AppIcon','CFBundleIconName':'AppIcon',**addition}))
    def test_recipe_and_fixed_override_keep_exact_compiler_and_copy_scope(self):
        args=[self.old['compiler'],*self.argv()];self.assertEqual(A.recipe(args)['options'],A.OPTIONS)
        args[-1]='iphoneos'
        with self.assertRaisesRegex(NativeRefused,'native_asset_recipe_changed'):A.recipe(args)
        config={'dartExecutable':'/dart','packageConfig':'/config','entrypoint':'/flutter','macosSdk':{'path':'/sdk'},'assetCache':self.ref}
        command=fixed_commands('macos_build',[],self.root,self.home,config,{'version':'1.40.0','buildNumber':'116'},'a'*64)[1]
        self.assertIn('ASSETCATALOG_EXEC='+str(self.directory/'actool'),command)
        wrapper=A.prepare_asset_cache(self.root,self.home,self.directory,self.ref);self.assertEqual(wrapper.name,'actool')

if __name__=='__main__':unittest.main()
